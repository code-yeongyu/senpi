import { mkdtempSync } from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentServerMessageSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import { frameConnectMessage, stream as streamCursorAgent } from "../src/api/cursor-agent.ts";
import { CURSOR_CONVERSATION_POISONED_MESSAGE } from "../src/api/cursor-conversation-rotation.ts";
import type { Model } from "../src/types.ts";

process.env.CURSOR_CONVERSATION_ID_STORE = join(mkdtempSync(join(tmpdir(), "cursor-rotate-")), "ids.json");

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
	// These cases drive several stream() calls against one server, so each leaves
	// an idle h2 session behind. server.close() waits for every session to end and
	// would never resolve, so the sessions are tracked and destroyed at teardown.
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

async function runStream(baseUrl: string, sessionId: string) {
	const result = streamCursorAgent(
		buildModel(baseUrl),
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{ apiKey: "test-token", sessionId, signal: neverAbortedSignal },
	);
	for await (const _event of result) {
		// drain
	}
	return await result.result();
}

describe("cursor-agent zero-token RE retry", () => {
	beforeEach(() => {
		// Rotation state is persisted per base conversation id, so each test needs
		// its own store or the 3-rotation cap leaks across cases.
		process.env.CURSOR_CONVERSATION_ID_STORE = join(mkdtempSync(join(tmpdir(), "cursor-rotate-")), "ids.json");
	});

	afterEach(async () => {
		if (!server) return;
		const closing = server;
		server = undefined;
		for (const session of sessions.splice(0)) {
			session.destroy();
		}
		await new Promise<void>((resolve) => closing.close(() => resolve()));
	});

	// The compact-before-rotate policy (#1015) reacts to a SURFACED 0-token RE in
	// agent-session. Rotating inside the first stream() attempt would swallow that
	// error and make compaction dead code, so attempt 1 must surface.
	it("surfaces the first 0-token RE without rotating so the session layer can compact", async () => {
		let runs = 0;
		const baseUrl = await startServer((stream) => {
			runs += 1;
			stream.write(endStreamErrorFrame("resource_exhausted", "Error"));
			stream.end();
		});
		const message = await runStream(baseUrl, "sess-first-surface");
		expect(runs).toBe(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/resource.?exhausted/i);
	});

	it("retries the same stream() with a new conversation id once the session retries", async () => {
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
		// First stream() call surfaces without rotating (session layer compacts).
		const first = await runStream(baseUrl, "sess-rotate-stream");
		expect(first.stopReason).toBe("error");
		expect(runs).toBe(1);

		// The session's retry re-enters stream(); its own attempt 1 surfaces-or-rotates
		// per the same rule, and the in-call retry rotates onto a fresh wire id.
		const second = await runStream(baseUrl, "sess-rotate-stream");
		expect(runs).toBe(3);
		expect(second.stopReason).not.toBe("error");
	});

	it("surfaces the poisoned-conversation error after the rotation cap", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(endStreamErrorFrame("resource_exhausted", "Error"));
			stream.end();
		});
		let message = await runStream(baseUrl, "sess-poisoned");
		// Each subsequent stream() call burns rotations until the cap is reached.
		for (let call = 0; call < 4; call++) {
			message = await runStream(baseUrl, "sess-poisoned");
			if (message.errorMessage === CURSOR_CONVERSATION_POISONED_MESSAGE) break;
		}
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(CURSOR_CONVERSATION_POISONED_MESSAGE);
	});
});
