// Issue #1741: the per-attempt summarization budget is size-scaled (2ms per
// estimated input token, 30-minute ceiling), so a large session legally licenses
// a 690s+ stream and every retry re-arms that budget from scratch. One compaction
// needs a wall-clock bound that does not grow with the input.
import { describe, expect, it } from "vitest";
import {
	createSummarizationDeadline,
	SUMMARIZATION_MAX_DURATION_CAP_MS,
	SUMMARIZATION_TOTAL_BUDGET_MS,
	SummarizationTotalBudgetError,
	summarizationMaxDurationMs,
	summarizationTotalBudgetMs,
} from "../../src/core/compaction/stream-watchdog.ts";
import { classifyRequiredCompactionFallbackFailure } from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";

describe("one compaction is bounded across every attempt and retry", () => {
	it("keeps the total budget independent of input size", () => {
		expect(SUMMARIZATION_TOTAL_BUDGET_MS).toBe(900_000);
		expect(summarizationTotalBudgetMs()).toBe(SUMMARIZATION_TOTAL_BUDGET_MS);
		// A 345k-token input licenses a 690s attempt and a 900k-token input licenses
		// the full 30-minute ceiling; neither raises the total a session may wait.
		expect(summarizationMaxDurationMs(345_000)).toBe(690_000);
		expect(summarizationMaxDurationMs(1_000_000)).toBe(SUMMARIZATION_MAX_DURATION_CAP_MS);
		expect(summarizationTotalBudgetMs()).toBe(SUMMARIZATION_TOTAL_BUDGET_MS);
	});

	it("honors an explicit per-attempt override as the total, clamped to the ceiling", () => {
		expect(summarizationTotalBudgetMs(60_000)).toBe(SUMMARIZATION_TOTAL_BUDGET_MS);
		expect(summarizationTotalBudgetMs(1_200_000)).toBe(1_200_000);
		expect(summarizationTotalBudgetMs(5_000_000)).toBe(SUMMARIZATION_MAX_DURATION_CAP_MS);
		expect(summarizationTotalBudgetMs(0)).toBe(SUMMARIZATION_TOTAL_BUDGET_MS);
		expect(summarizationTotalBudgetMs(Number.NaN)).toBe(SUMMARIZATION_TOTAL_BUDGET_MS);
	});

	it("clamps each attempt to what is left and refuses a new attempt past the deadline", () => {
		let now = 1_000;
		const deadline = createSummarizationDeadline(10_000, () => now);
		expect(deadline.totalBudgetMs).toBe(10_000);
		expect(deadline.attemptBudgetMs(30_000)).toBe(10_000);
		now += 7_000;
		expect(deadline.remainingMs()).toBe(3_000);
		expect(deadline.attemptBudgetMs(30_000)).toBe(3_000);
		// A shorter request is never widened by the remaining budget.
		expect(deadline.attemptBudgetMs(500)).toBe(500);
		now += 3_000;
		expect(deadline.remainingMs()).toBe(0);
		expect(() => deadline.attemptBudgetMs(30_000)).toThrow(SummarizationTotalBudgetError);
	});

	it("routes an exhausted total budget into the deterministic fallback", () => {
		const error = new SummarizationTotalBudgetError(900_000);
		expect(error.message).toContain("900000ms");
		expect(classifyRequiredCompactionFallbackFailure(error)).toBe("summarization-timeout");
	});
});
