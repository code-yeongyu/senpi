import { describe, expect, it } from "vitest";
import { formatEvalCellStatus } from "../src/extension/eval-status.ts";
import type { EvalDetachedCellStatusEntry } from "../src/tool/detached-cell-manager.ts";

// senpi#1908: queued-only footers carry a state marker, not a fabricated execution duration.
describe("queued eval footer", () => {
	const queued: EvalDetachedCellStatusEntry = {
		cellId: "B",
		language: "js",
		summary: "second",
		startedAtMs: 0,
		queuedBehind: ["A"],
	};

	it.each([[queued], [queued, { ...queued, cellId: "C", summary: "third" }]])(
		"renders a queued marker instead of elapsed time for %j",
		(...entries) => {
			const status = formatEvalCellStatus(entries, 60_000);
			expect(status?.match(/\(([^)]+)\)$/)?.[1]).toBe("queued");
			expect(formatEvalCellStatus(entries, 120_000)).toBe(status);
		},
	);

	it("keeps elapsed time for mixed running and queued cells", () => {
		const running: EvalDetachedCellStatusEntry = { cellId: "A", language: "js", startedAtMs: 30_000 };
		const status = formatEvalCellStatus([running, queued], 60_000);
		expect(status?.match(/\(([^)]+)\)$/)?.[1]).toBe("30s");
		expect(status).toContain("queued");
	});
});
