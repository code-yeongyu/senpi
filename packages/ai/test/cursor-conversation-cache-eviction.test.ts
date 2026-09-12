import { mkdtempSync } from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentServerMessageSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import {
	frameConnectMessage,
	getCursorConversationCacheStats,
	stream as streamCursorAgent,
} from "../src/api/cursor-agent.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model } from "../src/types.ts";

process.env.CURSOR_CONVERSATION_ID_STORE = join(mkdtempSync(join(tmpdir(), "cursor-cache-")), "ids.json");

const neverAbortedSignal = new AbortController().signal;
const CONNECT_END_STREAM_FLAG = 0b00000010;

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

function endStreamErrorFrame(code: string, message: string): Buffer {
	return frameConnectMessage(
		new TextEncoder().encode(JSON.stringify({ error: { code, message } })),
		CONNECT_END_STREAM_FLAG,
	);
}

let server: http2.Http2Server | undefined;
let sessions: http2.ServerHttp2Session[] = [];

async function startServer(handler: (stream: http2.ServerHttp2Stream) => void): Promise<string> {
	server = http2.createServer();
	sessions = [];
	// Each stream() call leaves an idle h2 session behind; server.close() waits
	// for every session to end, so track and destroy them at teardown.
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

async function runStream(baseUrl: string, sessionId: string, userContent = "hello", conversationId?: string) {
	const result = streamCursorAgent(
		buildModel(baseUrl),
		{ messages: [{ role: "user", content: userContent, timestamp: 0 }] },
		{ apiKey: "test-token", sessionId, conversationId, signal: neverAbortedSignal },
	);
	for await (const _event of result) {
		// drain
	}
	return await result.result();
}

describe("cursor-agent conversation cache eviction (#1024)", () => {
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		// Rotation state is persisted per base conversation id, so each test gets
		// its own store; the module-level conversation caches are shared, so a
		// no-id cleanup (global teardown) resets them between tests.
		process.env.CURSOR_CONVERSATION_ID_STORE = join(mkdtempSync(join(tmpdir(), "cursor-cache-")), "ids.json");
		originalEnv = {
			PI_CURSOR_CONVERSATION_CACHE_LIMIT: process.env.PI_CURSOR_CONVERSATION_CACHE_LIMIT,
			PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES: process.env.PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES,
			PI_CURSOR_CONVERSATION_TOTAL_BLOB_LIMIT_BYTES: process.env.PI_CURSOR_CONVERSATION_TOTAL_BLOB_LIMIT_BYTES,
		};
		delete process.env.PI_CURSOR_CONVERSATION_CACHE_LIMIT;
		delete process.env.PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES;
		delete process.env.PI_CURSOR_CONVERSATION_TOTAL_BLOB_LIMIT_BYTES;
		cleanupSessionResources();
	});

	afterEach(async () => {
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		cleanupSessionResources();
		if (!server) return;
		const closing = server;
		server = undefined;
		for (const session of sessions.splice(0)) {
			session.destroy();
		}
		await new Promise<void>((resolve) => closing.close(() => resolve()));
	});

	it("drops only the cleaned-up session's conversation state and blobs", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(turnEndedFrame());
			stream.end();
		});
		await runStream(baseUrl, "sess-cleanup-a");
		await runStream(baseUrl, "sess-cleanup-b");
		expect(getCursorConversationCacheStats().keys).toEqual(
			expect.arrayContaining(["sess-cleanup-a", "sess-cleanup-b"]),
		);
		expect(getCursorConversationCacheStats().states).toBe(2);

		cleanupSessionResources("sess-cleanup-a");

		const stats = getCursorConversationCacheStats();
		expect(stats.keys).toEqual(["sess-cleanup-b"]);
		expect(stats.conversations).toBe(1);
		expect(stats.states).toBe(1);
		expect(stats.blobBytes).toBeGreaterThan(0);
	});

	it("deletes the pre-rotation key when a poisoned conversation rotates", async () => {
		let runs = 0;
		const baseUrl = await startServer((stream) => {
			runs += 1;
			if (runs <= 2) {
				stream.write(endStreamErrorFrame("resource_exhausted", "Error"));
				stream.end();
				return;
			}
			stream.write(turnEndedFrame());
			stream.end();
		});
		// Run 1: first 0-token RE surfaces without rotating (session compacts).
		const first = await runStream(baseUrl, "sess-rotate-cache");
		expect(first.stopReason).toBe("error");
		// Run 2: the surfaced-again RE rotates in-call and the retry succeeds.
		const second = await runStream(baseUrl, "sess-rotate-cache");
		expect(second.stopReason).not.toBe("error");
		expect(runs).toBe(3);

		const stats = getCursorConversationCacheStats();
		expect(stats.conversations).toBe(1);
		expect(stats.states).toBe(1);
		expect(stats.keys).not.toContain("sess-rotate-cache");
	});

	it("caps the number of conversations one session caches, evicting the oldest first", async () => {
		// The cap is per owning session: one session's churn must never forget
		// another session's conversation, so the overflow is driven from a single
		// session cycling conversation ids.
		process.env.PI_CURSOR_CONVERSATION_CACHE_LIMIT = "3";
		const baseUrl = await startServer((stream) => {
			stream.write(turnEndedFrame());
			stream.end();
		});
		for (const conversationId of ["cap-1", "cap-2", "cap-3", "cap-4", "cap-5"]) {
			await runStream(baseUrl, "sess-cap", "hello", conversationId);
		}

		const stats = getCursorConversationCacheStats();
		expect(stats.conversations).toBe(3);
		expect(stats.states).toBe(3);
		expect(stats.keys).not.toContain("cap-1");
		expect(stats.keys).not.toContain("cap-2");
		expect(stats.keys).toEqual(["cap-3", "cap-4", "cap-5"]);
	});

	it("caps the bytes one conversation's blob store retains", async () => {
		process.env.PI_CURSOR_CONVERSATION_BLOB_LIMIT_BYTES = "4096";
		const baseUrl = await startServer((stream) => {
			stream.write(turnEndedFrame());
			stream.end();
		});
		await runStream(baseUrl, "sess-blob-cap", `big payload ${"x".repeat(200_000)}`);

		const stats = getCursorConversationCacheStats();
		expect(stats.keys).toEqual(["sess-blob-cap"]);
		expect(stats.blobBytes).toBeLessThanOrEqual(4096);
	});
});
