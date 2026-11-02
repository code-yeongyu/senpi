import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, TranscriptContext, Usage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	// oh-my-openagent#10792: billed query totals are not the last request's context.
	it("reserves output room using request context while retaining cumulative billing", () => {
		const assistant = createAssistant(100, 9_500);
		Object.assign(assistant.usage, { contextUsage: { input: 1_900, output: 100 } });
		const context = normalizeContext({
			messages: [assistant, { role: "user", content: "tail", timestamp: 101 }],
		});

		expect(estimateContextTokens(context).tokens).toBe(2_001);
		expect(buildBaseOptions(model, context).maxTokens).toBe(3_903);
		expect(assistant.usage.totalTokens).toBe(9_500);
	});

	it("estimates transcript size when only cumulative usage is available", () => {
		const assistant = createAssistant(100, 9_500);
		Object.assign(assistant.usage, { contextUsage: null });
		const context = normalizeContext({
			messages: [assistant, { role: "user", content: "tail", timestamp: 101 }],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2,
			usageTokens: 0,
			trailingTokens: 2,
			lastUsageIndex: null,
		});
	});

	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_899);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1])(
		"replaces invalid model maxTokens %s with the safe available context",
		(maxTokens) => {
			const context: TranscriptContext = normalizeContext({ messages: [] });

			expect(buildBaseOptions({ ...model, maxTokens }, context).maxTokens).toBe(5_904);
		},
	);

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1])(
		"replaces invalid requested maxTokens %s with the safe available context",
		(maxTokens) => {
			const context: TranscriptContext = normalizeContext({ messages: [] });

			expect(buildBaseOptions(model, context, { maxTokens }).maxTokens).toBe(5_904);
		},
	);
});
