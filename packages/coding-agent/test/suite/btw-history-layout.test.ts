import { describe, expect, it } from "vitest";
import {
	BTW_HISTORY_OVERLAY_CHROME_ROWS,
	BTW_HISTORY_OVERLAY_HEIGHT_RATIO,
	computeBtwHistoryLayout,
} from "../../src/core/extensions/builtin/btw/history-panel.ts";

const MIN_LAYOUT_ROWS = 3;
const FOOTER_ROWS = 1;

function overlayBudget(terminalRows: number): number {
	return Math.max(
		MIN_LAYOUT_ROWS,
		Math.floor(terminalRows * BTW_HISTORY_OVERLAY_HEIGHT_RATIO) - BTW_HISTORY_OVERLAY_CHROME_ROWS,
	);
}

describe("computeBtwHistoryLayout", () => {
	it("keeps the 34-row two-entry history panel within the overlay budget", () => {
		// given
		const budget = overlayBudget(34);

		// when
		const layout = computeBtwHistoryLayout({ terminalRows: 34, entryCount: 2 });

		// then
		expect(layout.questionRows).toBe(2);
		expect(layout.answerRows).toBe(budget - layout.questionRows - FOOTER_ROWS);
		expect(layout.questionRows + layout.answerRows + FOOTER_ROWS).toBeLessThanOrEqual(budget);
	});

	it("caps many history questions instead of starving the answer or footer rows", () => {
		// given
		const entryCount = 50;
		const budget = overlayBudget(34);

		// when
		const layout = computeBtwHistoryLayout({ terminalRows: 34, entryCount });

		// then
		expect(layout.questionRows).toBeLessThan(entryCount);
		expect(layout.questionRows).toBe(budget - 2);
		expect(layout.answerRows).toBe(1);
		expect(layout.questionRows + layout.answerRows + FOOTER_ROWS).toBeLessThanOrEqual(budget);
	});

	it.each([1, 5, 10])("returns valid rows for a tiny %i-row terminal", (terminalRows) => {
		// given
		const budget = overlayBudget(terminalRows);

		// when
		const layout = computeBtwHistoryLayout({ terminalRows, entryCount: 2 });

		// then
		expect(layout.questionRows).toBeGreaterThanOrEqual(0);
		expect(layout.answerRows).toBeGreaterThanOrEqual(1);
		expect(layout.questionRows + layout.answerRows + FOOTER_ROWS).toBeLessThanOrEqual(budget);
	});

	it.each([1, 2, 50])("reserves exactly one footer row for %i history entries", (entryCount) => {
		// given
		const budget = overlayBudget(34);

		// when
		const layout = computeBtwHistoryLayout({ terminalRows: 34, entryCount });

		// then
		expect(budget - layout.questionRows - layout.answerRows).toBe(FOOTER_ROWS);
		expect(layout.answerRows).toBeGreaterThanOrEqual(1);
	});
});
