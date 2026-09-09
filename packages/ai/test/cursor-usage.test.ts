import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServerMessageSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import { frameConnectMessage, stream as streamCursorAgent } from "../src/api/cursor-agent.ts";
import type { Model } from "../src/types.ts";

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

function serverFrame(init: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, init)));
}

function textDeltaFrame(text: string): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "textDelta", value: { text } } } },
	});
}

function tokenDeltaFrame(tokens: number): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "tokenDelta", value: { tokens } } } },
	});
}

function emptyTurnEndedFrame(): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } },
	});
}

function encodeVarint(value: bigint): number[] {
	let remaining = value;
	const bytes: number[] = [];
	while (true) {
		const byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining === 0n) {
			bytes.push(byte);
			return bytes;
		}
		bytes.push(byte | 0x80);
	}
}

/**
 * Hand-encoded turnEnded frame carrying the billed token fields the production
 * cursor-agent CLI schema (2026.08.11-e8db854) defines on
 * `agent.v1.TurnEndedUpdate`: 1 input_tokens, 2 output_tokens,
 * 3 cache_read_tokens, 4 cache_write_tokens, 5 reasoning_tokens (optional
 * int64 varints). Encoded manually so the test pins the observed wire shape
 * independent of the vendored schema in gen/agent_pb.ts.
 */
function billedTurnEndedFrame(fields: Readonly<Record<number, bigint>>): Buffer {
	const turnEnded: number[] = [];
	for (const [fieldNo, value] of Object.entries(fields)) {
		turnEnded.push(...encodeVarint(BigInt((Number(fieldNo) << 3) | 0)), ...encodeVarint(value));
	}
	// InteractionUpdate.turn_ended = 14 (length-delimited)
	const interactionUpdate = [
		...encodeVarint(BigInt((14 << 3) | 2)),
		...encodeVarint(BigInt(turnEnded.length)),
		...turnEnded,
	];
	// AgentServerMessage.interaction_update = 1 (length-delimited)
	const serverMessage = [
		...encodeVarint(BigInt((1 << 3) | 2)),
		...encodeVarint(BigInt(interactionUpdate.length)),
		...interactionUpdate,
	];
	return frameConnectMessage(Uint8Array.from(serverMessage));
}

function checkpointFrame(usedTokens: number, maxTokens: number): Buffer {
	return serverFrame({
		message: {
			case: "conversationCheckpointUpdate",
			value: { tokenDetails: { usedTokens, maxTokens } },
		},
	});
}

let server: http2.Http2Server | undefined;

async function startServer(handler: (stream: http2.ServerHttp2Stream) => void): Promise<string> {
	server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		handler(stream);
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server?.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

async function collectMessage(baseUrl: string) {
	const stream = streamCursorAgent(
		buildModel(baseUrl),
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{ signal: neverAbortedSignal, apiKey: "test-token" },
	);
	for await (const _event of stream) {
		// drain
	}
	return await stream.result();
}

describe("cursor-agent usage accounting", () => {
	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	it("maps billed turnEnded token fields onto usage", async () => {
		// Field values reproduce a live api2.cursor.sh second turn: input_tokens is
		// cache-INCLUSIVE (17989 = 17575 cacheRead + 411 cacheWrite + 3 uncached),
		// so usage.input carries only the uncached remainder.
		const baseUrl = await startServer((stream) => {
			stream.write(textDeltaFrame("hi"));
			stream.write(tokenDeltaFrame(5));
			stream.write(billedTurnEndedFrame({ 1: 17_989n, 2: 9n, 3: 17_575n, 4: 411n }));
			stream.end();
		});

		const message = await collectMessage(baseUrl);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.input).toBe(3);
		expect(message.usage.output).toBe(9);
		expect(message.usage.cacheRead).toBe(17_575);
		expect(message.usage.cacheWrite).toBe(411);
		expect(message.usage.totalTokens).toBe(3 + 9 + 17_575 + 411);
	});

	it("keeps delta-accumulated output when turnEnded omits output tokens", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(textDeltaFrame("hi"));
			stream.write(tokenDeltaFrame(7));
			stream.write(billedTurnEndedFrame({ 1: 100n, 3: 50n }));
			stream.end();
		});

		const message = await collectMessage(baseUrl);
		expect(message.usage.input).toBe(50);
		expect(message.usage.output).toBe(7);
		expect(message.usage.cacheRead).toBe(50);
		expect(message.usage.totalTokens).toBe(107);
	});

	it("applies checkpoint usedTokens to in-flight usage", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(textDeltaFrame("hi"));
			stream.write(tokenDeltaFrame(5));
			stream.write(checkpointFrame(17_962, 200_000));
			stream.write(emptyTurnEndedFrame());
			stream.end();
		});

		const message = await collectMessage(baseUrl);
		// The checkpoint reports the live conversation size; the split backs out
		// already-streamed output so context totals stay coherent.
		expect(message.usage.input).toBe(17_957);
		expect(message.usage.output).toBe(5);
		expect(message.usage.totalTokens).toBe(17_962);
	});

	it("does not let a late checkpoint clobber billed turnEnded usage", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(textDeltaFrame("hi"));
			stream.write(tokenDeltaFrame(5));
			stream.write(billedTurnEndedFrame({ 1: 17_579n, 2: 5n, 3: 17_574n }));
			stream.write(checkpointFrame(999_999, 200_000));
			stream.end();
		});

		const message = await collectMessage(baseUrl);
		expect(message.usage.input).toBe(5);
		expect(message.usage.output).toBe(5);
		expect(message.usage.cacheRead).toBe(17_574);
		expect(message.usage.totalTokens).toBe(5 + 5 + 17_574);
	});

	it("ignores billed cacheRead that dwarfs checkpoint usedTokens", async () => {
		// Session 01a01879: usedTokens ~148k, billed cache_read ~3.99M.
		const baseUrl = await startServer((stream) => {
			stream.write(textDeltaFrame("hi"));
			stream.write(tokenDeltaFrame(5));
			stream.write(checkpointFrame(148_256, 200_000));
			stream.write(billedTurnEndedFrame({ 1: 4_090_000n, 2: 5n, 3: 3_990_000n, 4: 100n }));
			stream.end();
		});

		const message = await collectMessage(baseUrl);
		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.totalTokens).toBe(148_256);
		expect(message.usage.totalTokens).toBeLessThan(200_000);
	});
});
