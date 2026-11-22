import { describe, expect, it } from "vitest";
import { tuiRenderCacheTotals } from "../../src/core/memory-report/memory-report-registry.ts";
import { ToolExecutionRenderCache } from "../../src/modes/interactive/components/tool-execution-cache.ts";

// senpi#1960 todo 2: the render cache is measurable - exact byte accounting per card and in the
// process-wide totals the memory report reads, so todo 17 can say what the cache costs.
// The report's `cachedLinesBytes` must equal the sum over cards of their rendered line bytes
// within 2% (the cross-check re-renders each card and sums); the same estimator runs both sides.

const BYTES_PER_LINE_SLOT = 8; // array pointer slot, matching the cache's own estimator

function renderedLineBytes(lines: readonly string[]): number {
	let bytes = lines.length * BYTES_PER_LINE_SLOT;
	for (const line of lines) bytes += line.length * 2;
	return bytes;
}

describe("tool-execution render cache byte accounting (#1960)", () => {
	it("keeps an exact byte count of cachedLines per card and in the module totals", () => {
		const cache = new ToolExecutionRenderCache();
		const totalsBefore = tuiRenderCacheTotals();
		const lines = ["line one", "a second, longer line", "3"];
		cache.store(80, "sig-1", lines);
		const totals = tuiRenderCacheTotals();
		expect(totals?.cachedLinesBytes).toBe((totalsBefore?.cachedLinesBytes ?? 0) + renderedLineBytes(lines));
		// When the store is replaced, the old lines leave the count
		const shorter = ["x"];
		cache.store(80, "sig-2", shorter);
		const replaced = tuiRenderCacheTotals();
		expect(replaced?.cachedLinesBytes).toBe((totalsBefore?.cachedLinesBytes ?? 0) + renderedLineBytes(shorter));
		cache.dispose();
		// Disposal returns every byte the card held
		const after = tuiRenderCacheTotals();
		expect(after?.cachedLinesBytes).toBe(totalsBefore?.cachedLinesBytes ?? 0);
	});

	it("carries finished-card counts and result bytes on the totals the report reads", () => {
		const cache = new ToolExecutionRenderCache();
		const finishedBefore = tuiRenderCacheTotals()?.finishedCards ?? 0;
		const resultBefore = tuiRenderCacheTotals()?.resultBytes ?? 0;
		cache.finalizeResult(12345);
		const totals = tuiRenderCacheTotals();
		expect(totals?.finishedCards).toBe(finishedBefore + 1);
		expect(totals?.resultBytes).toBe(resultBefore + 12345);
		cache.dispose();
		const after = tuiRenderCacheTotals();
		expect(after?.finishedCards).toBe(finishedBefore);
		expect(after?.resultBytes).toBe(resultBefore);
	});
});
