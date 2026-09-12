import { mkdtempSync } from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	GetBlobArgsSchema,
	KvServerMessageSchema,
} from "../src/api/cursor-agent/gen/agent_pb.ts";
import {
	frameConnectMessage,
	getCursorConversationCacheStats,
	stream as streamCursorAgent,
} from "../src/api/cursor-agent.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Message, Model } from "../src/types.ts";

const neverAbortedSignal = new AbortController().signal;

function buildModel(baseUrl: string): Model<"cursor-agent"> {
	return {
		id: "claude-4.6-opus-high",
		name: "Opus 4.6",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function turnEndedFrame(): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } },
			}),
		),
	);
}

function getBlobArgsFrame(id: number, blobId: Uint8Array): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "kvServerMessage",
					value: create(KvServerMessageSchema, {
						id,
						message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
					}),
				},
			}),
		),
	);
}

/** Reassembles Connect frames from an HTTP/2 stream's chunks. */
function createFrameReader(onFrame: (payload: Buffer) => void): (chunk: Buffer) => void {
	let buffer = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 5) {
			const length = buffer.readUInt32BE(1);
			if (buffer.length < 5 + length) return;
			onFrame(buffer.subarray(5, 5 + length));
			buffer = buffer.subarray(5 + length);
		}
	};
}

const EVICTION_ENV_KEYS = [
	"PI_CURSOR_CONVERSATION_CACHE_LIMIT",
	"PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES",
	"PI_CURSOR_CONVERSATION_TOTAL_BLOB_LIMIT_BYTES",
] as const;

function captureEvictionEnv(): Record<string, string | undefined> {
	const captured: Record<string, string | undefined> = {};
	for (const key of EVICTION_ENV_KEYS) {
		captured[key] = process.env[key];
		delete process.env[key];
	}
	return captured;
}

function restoreEvictionEnv(captured: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(captured)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** Awaits a predicate driven by other in-flight work, bounded by the test timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setImmediate(resolve));
	}
}

let server: http2.Http2Server | undefined;
let sessions: http2.ServerHttp2Session[] = [];

async function closeServer(): Promise<void> {
	if (!server) return;
	const closing = server;
	server = undefined;
	for (const session of sessions.splice(0)) {
		session.destroy();
	}
	await new Promise<void>((resolve) => closing.close(() => resolve()));
}

async function startServer(handler: (stream: http2.ServerHttp2Stream) => void): Promise<string> {
	server = http2.createServer();
	sessions = [];
	server.on("session", (session) => {
		sessions.push(session);
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		handler(stream);
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

async function runStream(
	baseUrl: string,
	options: { sessionId: string; conversationId?: string; messages?: Message[] },
): Promise<void> {
	const result = streamCursorAgent(
		buildModel(baseUrl),
		{ messages: options.messages ?? [{ role: "user", content: "hello", timestamp: 0 }] },
		{
			apiKey: "test-token",
			sessionId: options.sessionId,
			conversationId: options.conversationId,
			signal: neverAbortedSignal,
		},
	);
	for await (const _event of result) {
		// drain
	}
	await result.result();
}

/** History big enough that its blobs alone blow past a small byte budget. */
function buildLongHistory(turns: number, filler: number): Message[] {
	const messages: Message[] = [];
	for (let turn = 0; turn < turns; turn++) {
		messages.push({ role: "user", content: `ask ${turn} ${"q".repeat(filler)}`, timestamp: turn });
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `answer ${turn} ${"a".repeat(filler)}` }],
			timestamp: turn,
			api: "cursor-agent",
			provider: "cursor",
			model: "claude-4.6-opus-high",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		});
	}
	messages.push({ role: "user", content: "final question", timestamp: turns });
	return messages;
}

/** Every blob id the request's conversation state references. */
function collectRequestBlobIds(frame: Buffer): Uint8Array[] {
	const clientMessage = fromBinary(AgentClientMessageSchema, frame);
	if (clientMessage.message.case !== "runRequest") return [];
	const state = clientMessage.message.value.conversationState;
	if (!state) return [];
	return [...state.rootPromptMessagesJson, ...state.turns];
}

describe("cursor-agent blob pinning for the in-flight request (#1024)", () => {
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		process.env.CURSOR_CONVERSATION_ID_STORE = join(mkdtempSync(join(tmpdir(), "cursor-pin-")), "ids.json");
		originalEnv = captureEvictionEnv();
		cleanupSessionResources();
	});

	afterEach(async () => {
		restoreEvictionEnv(originalEnv);
		cleanupSessionResources();
		await closeServer();
	});

	it("resolves every blob the in-flight request references even past the byte budget", async () => {
		// The pinned history alone exceeds the cap, so a cap that evicts live
		// references would answer at least one getBlobArgs with an empty blob.
		process.env.PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES = "4096";
		const misses: string[] = [];
		let requested = 0;
		const baseUrl = await startServer((stream) => {
			let asked = false;
			const answers = new Map<number, Uint8Array>();
			const readFrame = createFrameReader((payload) => {
				const clientMessage = fromBinary(AgentClientMessageSchema, payload);
				if (clientMessage.message.case === "kvClientMessage") {
					const kv = clientMessage.message.value;
					if (kv.message.case === "getBlobResult") {
						const data = kv.message.value.blobData;
						if (!data || data.byteLength === 0) misses.push(String(kv.id));
						answers.set(kv.id, data ?? new Uint8Array());
						if (answers.size === requested) {
							stream.write(turnEndedFrame());
							stream.end();
						}
					}
					return;
				}
				if (asked) return;
				asked = true;
				const blobIds = collectRequestBlobIds(payload);
				requested = blobIds.length;
				expect(requested).toBeGreaterThan(4);
				blobIds.forEach((blobId, index) => {
					stream.write(getBlobArgsFrame(index + 1, blobId));
				});
			});
			stream.on("data", readFrame);
		});

		await runStream(baseUrl, {
			sessionId: "sess-pinned",
			messages: buildLongHistory(8, 2_000),
		});

		expect(misses).toEqual([]);
	});

	it("drops the pins once the stream settles so the byte cap applies again", async () => {
		process.env.PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES = "4096";
		const baseUrl = await startServer((stream) => {
			stream.write(turnEndedFrame());
			stream.end();
		});

		await runStream(baseUrl, { sessionId: "sess-unpin", messages: buildLongHistory(8, 2_000) });

		// Over budget only while the request is in flight: once it settles the pins
		// are released and the cold end is trimmed back to the cap.
		expect(getCursorConversationCacheStats().blobBytes).toBeLessThanOrEqual(4096);
	});

	it("holds every cached conversation under the process-global blob ceiling", async () => {
		// Per-conversation cap generous, process ceiling tight: the ceiling is what
		// bounds the process once many settled conversations are cached.
		process.env.PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES = String(4 * 1024 * 1024);
		process.env.PI_CURSOR_CONVERSATION_TOTAL_BLOB_LIMIT_BYTES = String(64 * 1024);
		const baseUrl = await startServer((stream) => {
			stream.write(turnEndedFrame());
			stream.end();
		});

		for (const conversationId of ["ceiling-1", "ceiling-2", "ceiling-3", "ceiling-4"]) {
			await runStream(baseUrl, {
				sessionId: "sess-ceiling",
				conversationId,
				messages: buildLongHistory(4, 8_000),
			});
		}

		expect(getCursorConversationCacheStats().blobBytes).toBeLessThanOrEqual(64 * 1024);
	});
});

describe("cursor-agent per-session conversation cache cap (#1024)", () => {
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		process.env.CURSOR_CONVERSATION_ID_STORE = join(mkdtempSync(join(tmpdir(), "cursor-pin-")), "ids.json");
		originalEnv = captureEvictionEnv();
		cleanupSessionResources();
	});

	afterEach(async () => {
		restoreEvictionEnv(originalEnv);
		cleanupSessionResources();
		await closeServer();
	});

	it("never evicts another session's conversations when one session overflows", async () => {
		process.env.PI_CURSOR_CONVERSATION_CACHE_LIMIT = "2";
		const baseUrl = await startServer((stream) => {
			stream.write(turnEndedFrame());
			stream.end();
		});

		await runStream(baseUrl, { sessionId: "sess-a", conversationId: "a-1" });
		await runStream(baseUrl, { sessionId: "sess-a", conversationId: "a-2" });
		for (const conversationId of ["b-1", "b-2", "b-3", "b-4"]) {
			await runStream(baseUrl, { sessionId: "sess-b", conversationId });
		}

		const keys = getCursorConversationCacheStats().keys;
		expect(keys).toContain("a-1");
		expect(keys).toContain("a-2");
		expect(keys.filter((key) => key.startsWith("b-")).length).toBe(2);
	});

	it("never evicts a session's own live conversation when that session overflows", async () => {
		process.env.PI_CURSOR_CONVERSATION_CACHE_LIMIT = "2";
		let releaseLive: (() => void) | undefined;
		const baseUrl = await startServer((stream) => {
			const readFrame = createFrameReader((payload) => {
				const clientMessage = fromBinary(AgentClientMessageSchema, payload);
				if (clientMessage.message.case !== "runRequest") return;
				const conversationId = clientMessage.message.value.conversationId;
				if (conversationId !== "live-1") {
					stream.write(turnEndedFrame());
					stream.end();
					return;
				}
				releaseLive = () => {
					stream.write(turnEndedFrame());
					stream.end();
				};
			});
			stream.on("data", readFrame);
		});

		const live = runStream(baseUrl, { sessionId: "sess-live", conversationId: "live-1" });
		// Wait for the live request to register its conversation before overflowing.
		await waitFor(() => getCursorConversationCacheStats().keys.includes("live-1"));
		for (const conversationId of ["fill-1", "fill-2", "fill-3"]) {
			await runStream(baseUrl, { sessionId: "sess-live", conversationId });
		}
		expect(getCursorConversationCacheStats().keys).toContain("live-1");
		await waitFor(() => releaseLive !== undefined);
		releaseLive?.();
		await live;
	});
});
