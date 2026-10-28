import { describe, expect, it } from "vitest";
import {
	buildBaseOptions,
	CONTEXT_SAFETY_TOKENS,
	ContextWindowExhaustedError,
	clampMaxTokensToContext,
} from "../src/api/simple-options.ts";
import type { Model } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { CONTEXT_WINDOW, contextWithEstimate, FIRST_EXHAUSTED_ESTIMATE } from "./context-exhaustion-fixtures.ts";

// oh-my-openagent#11684: usage reported before a model switch was counted by another tokenizer.
const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: CONTEXT_WINDOW,
	maxTokens: 8_000,
};

const USAGE_TIMESTAMP = 100;
const TRANSCRIPT_ESTIMATE = 2;

describe("contextUsageNotBefore", () => {
	const context = normalizeContext(contextWithEstimate(FIRST_EXHAUSTED_ESTIMATE));

	it("estimates from the transcript when the only usage predates the bound", () => {
		expect(estimateContextTokens(context, { usageNotBefore: USAGE_TIMESTAMP + 1 })).toEqual({
			tokens: TRANSCRIPT_ESTIMATE,
			usageTokens: 0,
			trailingTokens: TRANSCRIPT_ESTIMATE,
			lastUsageIndex: null,
		});
		expect(estimateContextTokens(context, { usageNotBefore: USAGE_TIMESTAMP }).tokens).toBe(FIRST_EXHAUSTED_ESTIMATE);
	});

	it("never refuses a request as exhausted on usage reported before the bound", () => {
		const room = CONTEXT_WINDOW - TRANSCRIPT_ESTIMATE - CONTEXT_SAFETY_TOKENS;

		expect(clampMaxTokensToContext(model, context, model.maxTokens, USAGE_TIMESTAMP + 1)).toBe(room);
		expect(buildBaseOptions(model, context, { contextUsageNotBefore: USAGE_TIMESTAMP + 1 }).maxTokens).toBe(room);
		expect(() => buildBaseOptions(model, context, { contextUsageNotBefore: USAGE_TIMESTAMP })).toThrow(
			ContextWindowExhaustedError,
		);
	});
});
