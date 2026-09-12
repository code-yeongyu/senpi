import { describe, expect, it } from "vitest";
import { repairedOutputBudget } from "../src/utils/prefill-budget-recovery.ts";

function report(window: number, input: number, completion: number, total = input + completion): Error {
	return new Error(
		`Prefill server error (400 Bad Request): Requested token count exceeds the model's maximum context length of ${window} tokens. You requested a total of ${total} tokens: ${input} tokens from the input messages and ${completion} tokens for the completion.`,
	);
}

describe("prefill budget evidence", () => {
	it.each([
		{ window: 294_912, input: 210_744, completion: 131_072, thinking: 16_384, expected: 80_072 },
		{ window: 10_000, input: 4880, completion: 6000, thinking: 0, expected: 1024 },
		{ window: 10_000, input: 4881, completion: 6000, thinking: 0, expected: undefined },
		{ window: 30_000, input: 8480, completion: 30_000, thinking: 16_400, expected: 17_424 },
		{ window: 30_000, input: 8481, completion: 30_000, thinking: 16_400, expected: undefined },
		{ window: 294_912, input: 210_744, completion: 1000, thinking: 0, expected: undefined },
		{ window: 294_912, input: 300_000, completion: 131_072, thinking: 0, expected: undefined },
	])(
		"respects the safety and reasoning reservation for $input input tokens",
		({ window, input, completion, thinking, expected }) => {
			// Given: internally consistent server counts and the actual requested cap.
			const error = report(window, input, completion);
			// When: computing an evidenced correction.
			const result = repairedOutputBudget(error, { requested: completion, thinkingTokens: thinking });
			// Then: preserve the established answer/safety floor or leave recovery to the caller.
			expect(result).toBe(expected);
		},
	);

	it.each([
		report(294_912, 210_744, 131_072, 341_817),
		report(294_912, 210_744, 130_000),
		report(294_912, 0, 131_072),
		report(-1, 210_744, 131_072),
		report(294_912, Number.MAX_SAFE_INTEGER + 1, 131_072),
		new Error("HTTP 429: too many tokens per minute"),
	])("does not infer a correction from invalid or unrelated evidence %#", (error) => {
		// Given: missing, contradictory or out-of-contract numbers.
		const budget = { requested: 131_072, thinkingTokens: 0 };
		// When: interpreting the report.
		const result = repairedOutputBudget(error, budget);
		// Then: no repair is authorized.
		expect(result).toBeUndefined();
	});
});
