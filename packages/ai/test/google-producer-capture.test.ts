import { describe, expect, it, vi } from "vitest";

const genai = vi.hoisted(() => ({ chunks: [] as Array<Record<string, unknown>> }));

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		models = {
			generateContentStream: async function* () {
				yield* genai.chunks;
			},
		};
	},
	FinishReason: {
		STOP: "STOP",
		MAX_TOKENS: "MAX_TOKENS",
		SAFETY: "SAFETY",
		RECITATION: "RECITATION",
		OTHER: "OTHER",
		BLOCKLIST: "BLOCKLIST",
		PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
		SPII: "SPII",
		MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
		UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
	},
	FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
	ResourceScope: { COLLECTION: "COLLECTION" },
	ThinkingLevel: {
		THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
		MINIMAL: "MINIMAL",
		LOW: "LOW",
		MEDIUM: "MEDIUM",
		HIGH: "HIGH",
	},
}));

import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { getModel } from "../src/compat.ts";
import { getAssistantCapture } from "../src/utils/assistant-capture.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	mintedIdentityKeys,
	progressRecords,
	publicBytes,
	publicEvents,
	recordKinds,
	subscribeCaptureForEachTest,
} from "./producer-capture-records.ts";

subscribeCaptureForEachTest();

const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
const args = { text: "a  b", n: 1 };
const executableCode = { executableCode: { language: "PYTHON", code: "print(1)" } };
const groundingMetadata = { webSearchQueries: ["q"] };
const urlContextMetadata = { urlMetadata: [{ retrievedUrl: "https://docs.example.com" }] };
const adapters: [string, () => AssistantMessageEventStream][] = [
	["google", () => streamGoogle(getModel("google", "gemini-2.5-flash"), context, { apiKey: "x" })],
	["vertex", () => streamVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, { apiKey: "x" })],
];

function parts(...value: Record<string, unknown>[]) {
	return { candidates: [{ content: { parts: value } }] };
}

function capture(open: () => AssistantMessageEventStream) {
	genai.chunks = [
		{ responseId: "resp_google", ...parts({ text: "plan", thought: true, thoughtSignature: "c2lnMQ==" }) },
		parts({ text: " more", thought: true }),
		parts({ text: "answer", thoughtSignature: "dHh0MQ==" }),
		parts({ functionCall: { id: "call_1", name: "echo", args } }),
		parts(executableCode),
		{
			candidates: [{ content: { parts: [] }, groundingMetadata, urlContextMetadata, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
		},
	];
	return drainRecords(open());
}

function native(contentIndex: number, subtype: string, raw: object) {
	const block = { type: "providerNative", subtype, raw };
	return [
		{ type: "message_block_state", contentIndex, phase: "insert", block },
		{ type: "message_block_state", contentIndex, phase: "end", block },
	];
}

describe.each(adapters)("%s producer capture #4272", (_name, open) => {
	it("keeps the public bytes recorded before capture", async () => {
		expect(publicBytes(publicEvents(await capture(open)))).toMatchSnapshot();
	});

	it("records signature changes and event-less native blocks in order", async () => {
		const records = await capture(open);
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"message_block_metadata:0",
			"thinking_delta:0",
			"thinking_delta:0",
			"thinking_end:0",
			"text_start:1",
			"message_block_metadata:1",
			"text_delta:1",
			"text_end:1",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_end:2",
			"message_block_state:3:insert",
			"message_block_state:3:end",
			"message_block_state:4:insert",
			"message_block_state:4:end",
			"message_block_state:5:insert",
			"message_block_state:5:end",
			"done",
		]);
		const progress = progressRecords(records);
		expect(progress).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignature: "c2lnMQ==" },
			{ type: "message_block_metadata", contentIndex: 1, textSignature: "dHh0MQ==" },
			...native(3, "executableCode", executableCode),
			...native(4, "groundingMetadata", groundingMetadata),
			...native(5, "urlContextMetadata", urlContextMetadata),
		]);
		const states = progress.flatMap((record) => (record.type === "message_block_state" ? [record] : []));
		expect(states.every((record) => Object.isFrozen(record.block))).toBe(true);
		// A block complete at insertion carries its content once: both transitions share one frozen copy.
		expect(states[0]?.block).toBe(states[1]?.block);
		const events = publicEvents(records);
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))?.block).toEqual({
			type: "thinking",
			thinking: "",
			thinkingSignature: undefined,
		});
		expect(getAssistantCapture(firstEvent(events, "text_end", 1))?.block).toEqual({
			type: "text",
			text: "answer",
			textSignature: "dHh0MQ==",
		});
	});

	it("keeps the complete parsed seed and the emitted spelling without a parse", async () => {
		const events = publicEvents(await capture(open));
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 2))).toMatchObject({
			block: { type: "toolCall", id: "call_1", name: "echo", arguments: args },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		expect(deltaCaptures(events, "toolcall_delta")).toEqual([
			{ delta: '{"text":"a  b","n":1}', offset: 0, parsedThrough: 0 },
		]);
		const done = getAssistantCapture(firstEvent(events, "done"))?.message;
		expect(done).toMatchObject({ stopReason: "toolUse" });
		expect(mintedIdentityKeys(done)).toEqual([]);
	});
});
