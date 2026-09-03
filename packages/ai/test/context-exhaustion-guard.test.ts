import { describe, expect, it } from "vitest";
import {
	buildBaseOptions,
	CONTEXT_GUARD_MIN_WINDOW,
	ContextWindowExhaustedError,
	clampMaxTokensToContext,
	MIN_ANSWER_TOKENS,
} from "../src/api/simple-options.ts";
import type { Context, Model } from "../src/types.ts";
import {
	CONTEXT_WINDOW,
	contextWithEstimate,
	FIRST_EXHAUSTED_ESTIMATE,
	LAST_ADMITTED_ESTIMATE,
} from "./context-exhaustion-fixtures.ts";

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

function captureExhaustion(context: Context): ContextWindowExhaustedError {
	try {
		buildBaseOptions(model, context);
	} catch (error) {
		if (error instanceof ContextWindowExhaustedError) return error;
		throw error;
	}
	throw new Error("expected buildBaseOptions to reject the exhausted context");
}

describe("context exhaustion guard", () => {
	it("refuses to clamp max tokens below the minimum answer room", () => {
		const context = contextWithEstimate(FIRST_EXHAUSTED_ESTIMATE);

		expect(() => clampMaxTokensToContext(model, context, model.maxTokens)).toThrow(ContextWindowExhaustedError);
		expect(() => buildBaseOptions(model, context)).toThrow(ContextWindowExhaustedError);
	});

	it("names the estimate, the window, and the remedy in the error", () => {
		const error = captureExhaustion(contextWithEstimate(FIRST_EXHAUSTED_ESTIMATE));

		expect(error.estimatedTokens).toBe(FIRST_EXHAUSTED_ESTIMATE);
		expect(error.contextWindow).toBe(CONTEXT_WINDOW);
		expect(error.message).toMatch(/^Context window exhausted/);
		expect(error.message).toContain(`${FIRST_EXHAUSTED_ESTIMATE} of ${CONTEXT_WINDOW} tokens`);
		expect(error.message).toContain(`fewer than ${MIN_ANSWER_TOKENS} tokens`);
		expect(error.message).toMatch(/compact/i);
	});

	it("admits a request that still has exactly the minimum answer room", () => {
		const context = contextWithEstimate(LAST_ADMITTED_ESTIMATE);

		expect(buildBaseOptions(model, context).maxTokens).toBe(MIN_ANSWER_TOKENS);
	});

	it("keeps an explicitly small max tokens request on a small context", () => {
		const context: Context = { messages: [{ role: "user", content: "OK", timestamp: 1 }] };

		expect(buildBaseOptions(model, context, { maxTokens: 1 }).maxTokens).toBe(1);
	});

	it("skips the guard for models without a known context window", () => {
		const context = contextWithEstimate(FIRST_EXHAUSTED_ESTIMATE);

		expect(buildBaseOptions({ ...model, contextWindow: 0 }, context).maxTokens).toBe(model.maxTokens);
	});

	it("keeps the legacy one-token floor for windows smaller than the guard geometry", () => {
		const context: Context = { messages: [{ role: "user", content: "OK", timestamp: 1 }] };

		expect(buildBaseOptions({ ...model, contextWindow: 1000 }, context).maxTokens).toBe(1);
		expect(() => buildBaseOptions({ ...model, contextWindow: CONTEXT_GUARD_MIN_WINDOW }, context)).toThrow(
			ContextWindowExhaustedError,
		);
	});
});
