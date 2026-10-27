import { describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			const items = wire.items;
			return Promise.resolve({
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield* items;
				})(),
			});
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException: class extends Error {},
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Model } from "../src/types.ts";
import { getAssistantCapture } from "../src/utils/assistant-capture.ts";
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

const model: Model<"bedrock-converse-stream"> = {
	id: "global.openai.gpt-5.6-terra",
	name: "fixture",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};
const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
const rawParts = ['{ "text"', "", ': "\\u00e9 \\"x\\"" }'];
const raw = rawParts.join("");

function reasoning(contentBlockIndex: number, reasoningContent: Record<string, unknown>) {
	return { contentBlockDelta: { contentBlockIndex, delta: { reasoningContent } } };
}

function capture() {
	wire.items = [
		{ messageStart: { role: "assistant" } },
		reasoning(0, { text: "think " }),
		reasoning(0, { text: "more" }),
		reasoning(0, { signature: "sig-a" }),
		reasoning(0, { signature: "sig-b" }),
		{ contentBlockStop: { contentBlockIndex: 0 } },
		{ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "echo" } } } },
		...rawParts.map((input) => ({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input } } } })),
		{ contentBlockStop: { contentBlockIndex: 1 } },
		reasoning(2, { signature: "early" }),
		reasoning(2, { redactedContent: new Uint8Array([1, 2, 3]) }),
		reasoning(2, { redactedContent: new Uint8Array([4]) }),
		{ contentBlockStop: { contentBlockIndex: 2 } },
		{ messageStop: { stopReason: "tool_use" } },
		{ metadata: { usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } } },
	];
	return drainRecords(streamBedrock(model, context, {}));
}

describe("Bedrock producer capture #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		expect(publicBytes(publicEvents(await capture()))).toMatchSnapshot();
	});

	it("records silent signature growth and mid-block redaction in order", async () => {
		const records = await capture();
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"thinking_delta:0",
			"message_block_metadata:0",
			"message_block_metadata:0",
			"thinking_end:0",
			"toolcall_start:1",
			"toolcall_delta:1",
			"toolcall_delta:1",
			"toolcall_delta:1",
			"toolcall_end:1",
			"thinking_start:2",
			"message_block_metadata:2",
			"message_block_metadata:2",
			"thinking_delta:2",
			"thinking_end:2",
			"done",
		]);
		expect(progressRecords(records)).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig-a" },
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig-b" },
			{ type: "message_block_metadata", contentIndex: 2, thinkingSignatureDelta: "early" },
			{ type: "message_block_metadata", contentIndex: 2, redacted: true, thinkingSignature: "" },
		]);
		const events = publicEvents(records);
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))).toMatchObject({
			block: { type: "thinking", thinking: "", thinkingSignature: "" },
			coveredCodeUnits: 0,
		});
		expect(getAssistantCapture(firstEvent(events, "thinking_end", 0))?.block).toEqual({
			type: "thinking",
			thinking: "think more",
			thinkingSignature: "sig-asig-b",
		});
		expect(getAssistantCapture(firstEvent(events, "thinking_end", 2))?.block).toEqual({
			type: "thinking",
			thinking: "[Reasoning redacted]",
			thinkingSignature: "AQIDBA==",
			redacted: true,
		});
	});

	it("freezes the empty tool seed and advances the frontier with each provider parse", async () => {
		const events = publicEvents(await capture());
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 1))).toMatchObject({
			block: { type: "toolCall", id: "call_1", name: "echo", arguments: {} },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		expect(deltaCaptures(events, "toolcall_delta")).toEqual([
			{ delta: rawParts[0], offset: 0, parsedThrough: 8 },
			{ delta: "", offset: 8, parsedThrough: 8 },
			{ delta: rawParts[2], offset: 8, parsedThrough: raw.length },
		]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 1))?.block).toMatchObject({
			arguments: { text: 'é "x"' },
		});
		const done = getAssistantCapture(firstEvent(events, "done"))?.message;
		expect(done).toMatchObject({ stopReason: "toolUse" });
		expect(mintedIdentityKeys(done)).toEqual([]);
	});
});
