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
import type { AssistantMessage } from "../src/types.ts";
import { type AssistantRecord, getAssistantCapture, isAssistantProgress } from "../src/utils/assistant-capture.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	progressRecords,
	publicBytes,
	publicEvents,
	subscribeCaptureForEachTest,
} from "./producer-capture-records.ts";

subscribeCaptureForEachTest();

const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
const adapters: [string, () => AssistantMessageEventStream][] = [
	["google", () => streamGoogle(getModel("google", "gemini-2.5-flash"), context, { apiKey: "x" })],
	["vertex", () => streamVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, { apiKey: "x" })],
];
const code = { executableCode: { language: "PYTHON", code: "print(1)" } };
const result = { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } };
const groundingMetadata = { webSearchQueries: ["q"] };
const urlContextMetadata = { urlMetadata: [{ retrievedUrl: "https://docs.example.com" }] };
const finish = {
	candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
	usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
};
const thinkingEnd = { type: "thinking", thinking: "plan more", thinkingSignature: "c2lnMQ==" };
const textEnd = { type: "text", text: "answer more", textSignature: "dHh0MQ==" };

function chunk(parts: Record<string, unknown>[], metadata: Record<string, unknown> = {}) {
	return { candidates: [{ content: { parts }, ...metadata }] };
}

function internalIndex(record: AssistantRecord): number | undefined {
	if (isAssistantProgress(record)) return record.contentIndex;
	if (!("contentIndex" in record)) return undefined;
	return getAssistantCapture(record)?.contentIndex ?? record.contentIndex;
}

function internalKinds(records: AssistantRecord[]): string[] {
	return records.map((record) => {
		const index = internalIndex(record);
		const phase = record.type === "message_block_state" ? `:${record.phase}` : "";
		return index === undefined ? record.type : `${record.type}:${index}${phase}`;
	});
}

function recordsOnForeignBlocks(records: AssistantRecord[], done: AssistantMessage): string[] {
	return records.flatMap((record) => {
		const index = internalIndex(record);
		if (index === undefined) return [];
		const kind = isAssistantProgress(record)
			? record.type === "message_block_state"
				? "providerNative"
				: "textSignature" in record
					? "text"
					: "thinking"
			: record.type.startsWith("toolcall")
				? "toolCall"
				: record.type.split("_")[0];
		const actual = done.content[index]?.type;
		return actual === kind ? [] : [`${record.type}:${index} names ${actual}`];
	});
}

const scenarios = {
	"thinking, then text, each interleaved": {
		chunks: [
			chunk([{ text: "plan", thought: true }]),
			chunk([code], { groundingMetadata }),
			chunk([{ text: " more", thought: true, thoughtSignature: "c2lnMQ==" }]),
			chunk([{ text: "answer" }]),
			chunk([result], { urlContextMetadata }),
			chunk([{ text: " more", thoughtSignature: "dHh0MQ==" }]),
			finish,
		],
		kinds: [
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"message_block_state:1:insert",
			"message_block_state:1:end",
			"message_block_state:2:insert",
			"message_block_state:2:end",
			"message_block_metadata:0",
			"thinking_delta:0",
			"thinking_end:0",
			"text_start:3",
			"text_delta:3",
			"message_block_state:4:insert",
			"message_block_state:4:end",
			"message_block_state:5:insert",
			"message_block_state:5:end",
			"message_block_metadata:3",
			"text_delta:3",
			"text_end:3",
			"done",
		],
		offsets: { thinking: [0, 4], text: [0, 6] },
		ends: [thinkingEnd, textEnd],
		signatures: [
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignature: "c2lnMQ==" },
			{ type: "message_block_metadata", contentIndex: 3, textSignature: "dHh0MQ==" },
		],
	},
	"text interleaved, closed by a function call": {
		chunks: [
			chunk([{ text: "answer" }]),
			chunk([code], { groundingMetadata, urlContextMetadata }),
			chunk([{ text: " more", thoughtSignature: "dHh0MQ==" }]),
			chunk([{ functionCall: { id: "call_1", name: "echo", args: { text: "x" } } }]),
			finish,
		],
		kinds: [
			"start",
			"text_start:0",
			"text_delta:0",
			"message_block_state:1:insert",
			"message_block_state:1:end",
			"message_block_state:2:insert",
			"message_block_state:2:end",
			"message_block_state:3:insert",
			"message_block_state:3:end",
			"message_block_metadata:0",
			"text_delta:0",
			"text_end:0",
			"toolcall_start:4",
			"toolcall_delta:4",
			"toolcall_end:4",
			"done",
		],
		offsets: { thinking: [], text: [0, 6] },
		ends: [textEnd],
		signatures: [{ type: "message_block_metadata", contentIndex: 0, textSignature: "dHh0MQ==" }],
	},
};

describe.each(adapters)("%s capture while native parts interleave #4272", (_name, open) => {
	it.each(Object.entries(scenarios))("keeps the open block's own index: %s", async (_scenario, expected) => {
		genai.chunks = expected.chunks;
		const records = await drainRecords(open());
		const events = publicEvents(records);
		expect(publicBytes(events)).toMatchSnapshot();
		expect(internalKinds(records)).toEqual(expected.kinds);
		expect(recordsOnForeignBlocks(records, firstEvent(events, "done").message)).toEqual([]);
		expect({
			thinking: deltaCaptures(events, "thinking_delta").map(({ offset }) => offset),
			text: deltaCaptures(events, "text_delta").map(({ offset }) => offset),
		}).toEqual(expected.offsets);
		const ends = events.flatMap((event) =>
			event.type === "text_end" || event.type === "thinking_end" ? [getAssistantCapture(event)?.block] : [],
		);
		expect(ends).toEqual(expected.ends);
		const signatures = progressRecords(records).filter((record) => record.type === "message_block_metadata");
		expect(signatures).toEqual(expected.signatures);
	});
});
