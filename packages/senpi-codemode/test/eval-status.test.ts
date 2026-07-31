import { describe, expect, it } from "vitest";
import { EVAL_CELLS_STATUS_KEY, formatEvalCellStatus } from "../src/extension/eval-status.ts";
import type { EvalDetachedCellStatusEntry } from "../src/tool/detached-cell-manager.ts";

const T0 = 1_000_000;

function entry(cellId: string, language: "js" | "py", title?: string, startedAtMs = T0): EvalDetachedCellStatusEntry {
	return title === undefined ? { cellId, language, startedAtMs } : { cellId, language, title, startedAtMs };
}

describe("formatEvalCellStatus", () => {
	it("exports the footer status key used for detached eval cells", () => {
		expect(EVAL_CELLS_STATUS_KEY).toBe("eval-cells");
	});

	it("returns undefined when no cells are detached, clearing the footer status", () => {
		expect(formatEvalCellStatus([], T0)).toBeUndefined();
	});

	it("shows glyph, language, and title for a single detached cell", () => {
		expect(formatEvalCellStatus([entry("cell-1", "py", "numpy feather rerun")], T0 + 5_000)).toBe(
			"↗ py · numpy feather rerun (5s)",
		);
	});

	it("falls back to the cell id when the cell has no title", () => {
		expect(formatEvalCellStatus([entry("cell-123", "js")], T0 + 180_000)).toBe("↗ js · cell-123 (3m)");
	});

	it("truncates an overlong single title to the shared 48-char budget with an ellipsis", () => {
		const longTitle = "x".repeat(80);
		const status = formatEvalCellStatus([entry("cell-1", "py", longTitle)], T0);
		expect(status).toBe(`↗ py · ${"x".repeat(48 - "↗ py · ".length - " (0s)".length - 1)}… (0s)`);
		expect(status?.length).toBe(48);
	});

	it("lists every title when multiple detached cells fit the budget", () => {
		expect(formatEvalCellStatus([entry("a", "js", "alpha"), entry("b", "py", "beta")], T0 + 60_000)).toBe(
			"↗ eval 2: alpha, beta (1m)",
		);
	});

	it("keeps only whole titles and folds the rest into a +N more tail", () => {
		const entries = [
			entry("a", "js", "first-cell-title"),
			entry("b", "py", "second-cell-title"),
			entry("c", "js", "third-cell-title"),
		];
		const status = formatEvalCellStatus(entries, T0);
		expect(status).toBe("↗ eval 3: first-cell-title +2 more (0s)");
		expect(status?.length).toBeLessThanOrEqual(48);
	});

	it("keeps the +N more counter when not even one whole title fits", () => {
		const entries = [
			entry("a", "js", "a-very-long-cell-title-that-cannot-fit"),
			entry("b", "py", "another-long-cell-title-that-cannot-fit"),
		];
		const status = formatEvalCellStatus(entries, T0);
		expect(status).toMatch(/^↗ eval 2: a-very-long-cell-tit\S*… \+1 more \(0s\)$/u);
		expect(status?.length).toBeLessThanOrEqual(48);
	});

	it("advances the elapsed label as time passes over the same entries", () => {
		const entries = [entry("cell-1", "py", "long running cell")];
		expect(formatEvalCellStatus(entries, T0 + 5_000)).toBe("↗ py · long running cell (5s)");
		expect(formatEvalCellStatus(entries, T0 + 6_000)).toBe("↗ py · long running cell (6s)");
	});

	it("shows the oldest cell's elapsed time when several cells are detached", () => {
		const entries = [entry("a", "js", "alpha"), entry("b", "py", "beta", T0 + 30_000)];
		expect(formatEvalCellStatus(entries, T0 + 90_000)).toBe("↗ eval 2: alpha, beta (1m)");
	});

	it("never shows negative elapsed when the clock moves backwards", () => {
		expect(formatEvalCellStatus([entry("cell-1", "py", "clock skew")], T0 - 5_000)).toBe("↗ py · clock skew (0s)");
	});
});
