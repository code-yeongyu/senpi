import { afterEach, expect, it, vi } from "vitest";

const genai = vi.hoisted(() => ({ chunks: [] as Array<Record<string, unknown>> }));

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		models = {
			generateContentStream: async function* () {
				yield* genai.chunks;
			},
		};
	},
	FinishReason: { STOP: "STOP", MAX_TOKENS: "MAX_TOKENS", SAFETY: "SAFETY", OTHER: "OTHER" },
	FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
	ResourceScope: { COLLECTION: "COLLECTION" },
	ThinkingLevel: { THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED", LOW: "LOW", HIGH: "HIGH" },
}));

import { stream as streamGoogle } from "../../../../ai/src/api/google-generative-ai.ts";
import { getModel } from "../../../../ai/src/compat.ts";
import { subscribeStructuredSessionRecords } from "../../../src/modes/rpc/structured-session-records.ts";
import { firstAssistantMessage, type Lane, type ScriptedSession, scriptedSession } from "../structured-lane-support.ts";

const sessions: ScriptedSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

function chunk(parts: Record<string, unknown>[], metadata: Record<string, unknown> = {}) {
	return { candidates: [{ content: { parts }, ...metadata }] };
}

type Indexed = Lane & { contentIndex?: number; phase?: string; textSignature?: string; delta?: string };

function blockKind(record: Indexed): string | undefined {
	if (record.type === "message_block_state") return "providerNative";
	if (record.type === "message_block_metadata") return record.textSignature === undefined ? "thinking" : "text";
	const kind = record.assistantMessageEvent?.type?.split("_")[0];
	return kind === "toolcall" ? "toolCall" : kind;
}

// #4285 L1/L2: Google's public contentIndex drifts after natively inserted parts; the lane must address the capture's own index.
it("T6 addresses interleaved Google blocks by the capture's own index on the structured lane", async () => {
	genai.chunks = [
		chunk([{ text: "plan", thought: true }]),
		chunk([{ executableCode: { language: "PYTHON", code: "print(1)" } }], {
			groundingMetadata: { webSearchQueries: ["q"] },
		}),
		chunk([{ text: " more", thought: true, thoughtSignature: "c2lnMQ==" }]),
		chunk([{ text: "answer" }]),
		chunk([{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } }], {
			urlContextMetadata: { urlMetadata: [{ retrievedUrl: "https://docs.example.com" }] },
		}),
		chunk([{ text: " more", thoughtSignature: "dHh0MQ==" }]),
		{
			candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
		},
	];
	const session = await scriptedSession([]);
	sessions.push(session);
	const google = getModel("google", "gemini-2.5-flash");
	session.harness.agent.streamFunction = (_model, context) => streamGoogle(google, context, { apiKey: "x" });
	const records: Indexed[] = [];
	const stop = subscribeStructuredSessionRecords(session.harness.session, (record) => records.push(record));
	try {
		await session.prompt("go");
	} finally {
		stop();
	}
	const turn = firstAssistantMessage(records) as Indexed[];
	const end = turn.at(-1);
	const content = (end?.message?.content ?? []) as Array<{ type: string; text?: string }>;
	expect(content.map((block) => block.type)).toEqual([
		"thinking",
		"providerNative",
		"providerNative",
		"text",
		"providerNative",
		"providerNative",
	]);
	expect(end?.invalidatedBlocks).toBeUndefined();
	const blockRecords = turn.flatMap((record) => {
		const index = record.contentIndex ?? record.assistantMessageEvent?.contentIndex;
		return index === undefined ? [] : [{ record, index }];
	});
	expect(blockRecords.length).toBeGreaterThan(12);
	expect(
		blockRecords.flatMap(({ record, index }) =>
			content[index]?.type === blockKind(record) ? [] : [`${record.type}:${index} names ${content[index]?.type}`],
		),
	).toEqual([]);
	const text = blockRecords.filter(({ record }) => record.assistantMessageEvent?.type?.startsWith("text_"));
	expect(text.map(({ record, index }) => `${record.assistantMessageEvent?.type}:${index}`)).toEqual([
		"text_start:3",
		"text_delta:3",
		"text_delta:3",
		"text_end:3",
	]);
});
