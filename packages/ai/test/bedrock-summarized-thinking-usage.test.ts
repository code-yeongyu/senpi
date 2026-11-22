import { beforeEach, describe, expect, it, vi } from "vitest";

// senpi#3399: Bedrock Converse never reports a reasoning token count, and Claude on
// Bedrock streams its reasoning as a summary (thinking.display "summarized" is the
// adapter's documented default). The adapter knows the display mode from the request
// it built, so it stamps usage.reasoningSummarized for Claude replies whose thinking
// streamed; non-Anthropic models stream raw reasoning, which is not a summary.

const bedrockMock = vi.hoisted(() => {
	return {
		streamEvents: undefined as unknown[] | undefined,
	};
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			if (bedrockMock.streamEvents) {
				const events = bedrockMock.streamEvents;
				return Promise.resolve({
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield* events;
					})(),
				});
			}
			return Promise.reject(new Error("mock send"));
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
		BedrockRuntimeServiceException,
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
		ImageFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function claudeOnBedrock(): Model<"bedrock-converse-stream"> {
	const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
	return {
		...baseModel,
		id: "global.anthropic.claude-opus-4-8-v1",
		name: "Claude Opus 4.8 (Global)",
	};
}

const gptOnBedrock: Model<"bedrock-converse-stream"> = {
	id: "global.openai.gpt-5.6-terra",
	name: "GPT-5.6 Terra (Global)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

/** Claude on Bedrock: a streamed reasoning summary, then the answer. */
function summarizedReasoningEvents(): unknown[] {
	return [
		{ messageStart: { role: "assistant" } },
		{
			contentBlockDelta: {
				contentBlockIndex: 0,
				delta: { reasoningContent: { text: "condensed plan", signature: "sig" } },
			},
		},
		{ contentBlockStop: { contentBlockIndex: 0 } },
		{ contentBlockDelta: { contentBlockIndex: 1, delta: { text: "done" } } },
		{ contentBlockStop: { contentBlockIndex: 1 } },
		{ messageStop: { stopReason: "end_turn" } },
		// Converse reports no reasoning token breakdown: outputTokens bills the thinking too.
		{ metadata: { usage: { inputTokens: 1, outputTokens: 3_400, totalTokens: 3_401 } } },
	];
}

const helloContext = () => normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });

describe("Bedrock summarized thinking usage marker (senpi#3399)", () => {
	beforeEach(() => {
		bedrockMock.streamEvents = undefined;
	});

	it("stamps usage.reasoningSummarized for Claude reasoning that streamed as a summary", async () => {
		bedrockMock.streamEvents = summarizedReasoningEvents();

		const response = await streamBedrock(claudeOnBedrock(), helloContext(), {
			reasoning: "high",
			cacheRetention: "none",
		}).result();

		expect(response.stopReason, response.errorMessage).not.toBe("error");
		expect(response.usage.reasoning).toBeUndefined();
		expect(response.usage.reasoningSummarized).toBe(true);
	});

	it("does not stamp the marker for a non-Anthropic model streaming raw reasoning", async () => {
		bedrockMock.streamEvents = summarizedReasoningEvents();

		const response = await streamBedrock(gptOnBedrock, helloContext(), {
			reasoning: "high",
			cacheRetention: "none",
		}).result();

		expect(response.stopReason, response.errorMessage).not.toBe("error");
		expect(response.usage.reasoningSummarized).toBeUndefined();
	});
});
