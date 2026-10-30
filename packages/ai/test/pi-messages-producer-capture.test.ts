import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
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

const argumentDeltas = ['{ "text": ', "", '"\\u00e9" }'];
const usage = {
	input: 3,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 7,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let server: Server | undefined;

afterEach(async () => {
	const closing = server;
	server = undefined;
	if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function serve(events: unknown[]): Promise<string> {
	const created = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
			response.end();
		});
	});
	server = created;
	await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
	const address = created.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}/v1`;
}

async function capture() {
	const baseUrl = await serve([
		{ type: "start" },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: "hi" },
		{ type: "text_end", contentIndex: 0, content: "hi", contentSignature: "tsig" },
		{ type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "echo" },
		...argumentDeltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 1, delta })),
		{
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { type: "toolCall", id: "call_1", name: "echo", arguments: { text: "é" } },
		},
		{ type: "done", reason: "toolUse", usage, responseId: "resp_pi" },
	]);
	const model: Model<"pi-messages"> = {
		id: "auto",
		name: "fixture",
		api: "pi-messages",
		provider: "radius",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
	const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
	return drainRecords(streamPiMessages(model, context, { apiKey: "fixture" }));
}

describe("Pi messages producer capture #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		expect(publicBytes(publicEvents(await capture()))).toMatchSnapshot();
	});

	it("captures the closure-held argument text as the emitted deltas with the store's parse frontier", async () => {
		const records = await capture();
		expect(recordKinds(records)).toEqual([
			"start",
			"text_start:0",
			"text_delta:0",
			"text_end:0",
			"toolcall_start:1",
			"toolcall_delta:1",
			"toolcall_delta:1",
			"toolcall_delta:1",
			"toolcall_end:1",
			"done",
		]);
		const events = publicEvents(records);
		expect(getAssistantCapture(firstEvent(events, "text_start", 0))?.block).toEqual({ type: "text", text: "" });
		expect(getAssistantCapture(firstEvent(events, "text_end", 0))?.block).toEqual({
			type: "text",
			text: "hi",
			textSignature: "tsig",
		});
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 1))).toMatchObject({
			block: { type: "toolCall", id: "call_1", name: "echo", arguments: {} },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		expect(deltaCaptures(events, "toolcall_delta")).toEqual([
			{ delta: argumentDeltas[0], offset: 0, parsedThrough: 10 },
			{ delta: "", offset: 10, parsedThrough: 10 },
			{ delta: argumentDeltas[2], offset: 10, parsedThrough: 20 },
		]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 1))?.block).toMatchObject({
			arguments: { text: "é" },
		});
		const done = getAssistantCapture(firstEvent(events, "done"))?.message;
		expect(done).toMatchObject({ stopReason: "toolUse", responseId: "resp_pi" });
		expect(mintedIdentityKeys(done)).toEqual([]);
	});
});
