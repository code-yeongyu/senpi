import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	BTW_HISTORY_OVERLAY_CHROME_ROWS,
	BTW_HISTORY_OVERLAY_HEIGHT_RATIO,
	computeBtwHistoryLayout,
	fitBtwHistoryRow,
} from "../../src/core/extensions/builtin/btw/history-panel.ts";

function overlayBudget(terminalRows: number): number {
	return Math.max(3, Math.floor(terminalRows * BTW_HISTORY_OVERLAY_HEIGHT_RATIO) - BTW_HISTORY_OVERLAY_CHROME_ROWS);
}

describe("btw history layout", () => {
	it("reserves answer and footer space when many questions exist", () => {
		const budget = overlayBudget(34);

		const layout = computeBtwHistoryLayout({ terminalRows: 34, entryCount: 50 });

		expect(layout.questionRows).toBe(budget - 2);
		expect(layout.answerRows).toBe(1);
		expect(layout.questionRows + layout.answerRows + 1).toBeLessThanOrEqual(budget);
	});

	it.each([1, 5, 10])("returns valid rows for a tiny %i-row terminal", (terminalRows) => {
		const layout = computeBtwHistoryLayout({ terminalRows, entryCount: 2 });

		expect(layout.questionRows).toBeGreaterThanOrEqual(0);
		expect(layout.answerRows).toBeGreaterThanOrEqual(1);
		expect(layout.questionRows + layout.answerRows + 1).toBeLessThanOrEqual(overlayBudget(terminalRows));
	});

	it("fits Korean and ASCII question rows by visible terminal width", () => {
		const row = fitBtwHistoryRow("→ /btw 한국어 질문 with ASCII suffix", 18);

		expect(visibleWidth(row)).toBeLessThanOrEqual(18);
	});
});
