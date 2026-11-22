import * as http2 from "node:http2";
import { create, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServerMessageSchema, type InteractionUpdateSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import { frameConnectMessage, stream as streamCursorAgent } from "../src/api/cursor-agent.ts";
import type { Model } from "../src/types.ts";
import { getAssistantCapture } from "../src/utils/assistant-capture.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	mintedIdentityKeys,
	publicBytes,
	publicEvents,
	recordKinds,
	subscribeCaptureForEachTest,
} from "./producer-capture-records.ts";

subscribeCaptureForEachTest();

type InteractionMessage = NonNullable<MessageInitShape<typeof InteractionUpdateSchema>["message"]>;

const mcpCall = {
	tool: { case: "mcpToolCall" as const, value: { args: { name: "echo", toolName: "echo", toolCallId: "call_1" } } },
};
// Cursor sends cumulative argument snapshots and reparses only after 1024 new code units.
const snapshots = [`{"text":"${"x".repeat(600)}`, `{"text":"${"x".repeat(600)}${"y".repeat(600)}`];
snapshots.push(`${snapshots[1]}"}`);

let server: http2.Http2Server | undefined;

afterEach(async () => {
	const closing = server;
	server = undefined;
	if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
});

function interaction(message: InteractionMessage): Buffer {
	const value = create(AgentServerMessageSchema, { message: { case: "interactionUpdate", value: { message } } });
	return frameConnectMessage(toBinary(AgentServerMessageSchema, value));
}

async function serve(frames: Buffer[]): Promise<string> {
	const created = http2.createServer();
	server = created;
	created.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		for (const frame of frames) stream.write(frame);
		stream.end();
	});
	await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
	const address = created.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

let turn = 0;
async function capture() {
	const baseUrl = await serve([
		interaction({ case: "thinkingDelta", value: { text: "hm" } }),
		interaction({ case: "toolCallStarted", value: { callId: "env-1", toolCall: mcpCall } }),
		...snapshots.map((argsTextDelta) =>
			interaction({ case: "partialToolCall", value: { callId: "env-1", argsTextDelta } }),
		),
		interaction({ case: "toolCallCompleted", value: { callId: "env-1", toolCall: mcpCall } }),
		interaction({ case: "turnEnded", value: {} }),
	]);
	const model: Model<"cursor-agent"> = {
		id: "composer-2",
		name: "fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
	const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
	turn++;
	return drainRecords(
		streamCursorAgent(model, context, {
			apiKey: "test-token",
			conversationId: `producer-capture-${turn}`,
			signal: new AbortController().signal,
		}),
	);
}

describe("Cursor producer capture #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		expect(publicBytes(publicEvents(await capture()))).toMatchSnapshot();
	});

	it("keeps the parse frontier at Cursor's throttled reparse, so the stale preview survives", async () => {
		const records = await capture();
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"thinking_end:0",
			"toolcall_start:1",
			"toolcall_delta:1",
			"toolcall_delta:1",
			"toolcall_delta:1",
			"toolcall_end:1",
			"done",
		]);
		const events = publicEvents(records);
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 1))).toMatchObject({
			block: { type: "toolCall", id: "call_1", name: "echo", arguments: {} },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		const deltas = deltaCaptures(events, "toolcall_delta");
		expect(deltas.map(({ offset, parsedThrough }) => ({ offset, parsedThrough }))).toEqual([
			{ offset: 0, parsedThrough: 0 },
			{ offset: 609, parsedThrough: 1209 },
			{ offset: 1209, parsedThrough: 1209 },
		]);
		expect(deltas.map(({ delta }) => delta).join("")).toBe(snapshots[2]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 1))?.block).toMatchObject({
			arguments: { text: `${"x".repeat(600)}${"y".repeat(600)}` },
		});
		const done = getAssistantCapture(firstEvent(events, "done"))?.message;
		expect(done).toMatchObject({ stopReason: "stop" });
		expect(mintedIdentityKeys(done)).toEqual([]);
	});
});
