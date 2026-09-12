import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the configured reserved height and defaults to two rows", () => {
		const defaultLines = new IdleStatus().render(20);
		const measuredLines = new IdleStatus(4).render(20);

		expect(defaultLines).toEqual([" ".repeat(20), " ".repeat(20)]);
		expect(measuredLines).toEqual(Array.from({ length: 4 }, () => " ".repeat(20)));
	});

	it("keeps the cancellation hint visible on narrow terminals before progress arrives", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new CompactionStatusIndicator(tui, "overflow");

		try {
			// No compaction_progress event has arrived, so only the width check can
			// collapse the long reason-specific label to the compact one.
			const lines = indicator.render(40);
			expect(lines).toHaveLength(1);
			const rendered = stripAnsi(lines[0] ?? "");
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(40);
			expect(rendered).toContain("to cancel");
		} finally {
			indicator.dispose();
		}
	});

	it("keeps the full reason-specific label when the terminal is wide enough", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new CompactionStatusIndicator(tui, "overflow");

		try {
			const lines = indicator.render(120);
			expect(lines).toHaveLength(1);
			const rendered = stripAnsi(lines[0] ?? "");
			expect(rendered).toContain("Context overflow detected");
			expect(rendered).toContain("to cancel");
		} finally {
			indicator.dispose();
		}
	});

	it("keeps the top border unchanged unless the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			getShowHardwareCursor: () => false,
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		expect(stripAnsi(editor.render(20)[0]!)).toBe("─".repeat(20));
		const standaloneLine = indicator.render(20)[1]!;
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		expect(standaloneLine).toContain(theme.getFgAnsi("muted"));
		indicator.dispose();
	});

	it("embeds the working indicator when the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			getShowHardwareCursor: () => false,
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		expect(editor.embedWorkingStatus).toBe(true);
		editor.borderColor = theme.getThinkingBorderColor("high");
		const indicator = new WorkingStatusIndicator(tui, "Working", undefined, (text) => editor.borderColor(text));
		editor.setWorkingStatusIndicator(indicator);

		const topBorder = editor.render(20)[0]!;
		expect(stripAnsi(topBorder)).toBe("── ⠋ Working ───────");
		expect(visibleWidth(topBorder)).toBe(20);
		expect(topBorder.split(theme.getFgAnsi("thinkingHigh"))).toHaveLength(5);
		indicator.dispose();
	});

	it("embeds compaction, summary, and retry labels within the border width", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = {
			requestRender: vi.fn(),
			getShowHardwareCursor: () => false,
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				editor.setWorkingStatusIndicator(indicator);
				// The fork's compaction indicator renders a single row; the others keep Loader's spacer row.
				const label = stripAnsi(indicator.render(120).at(-1)!).trim();
				expect(stripAnsi(editor.render(120)[0]!)).toContain(`── ${label} `);
				for (const width of [1, 4, 10, 20, 80, 120]) {
					expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
				}
			}
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(editor.render(120)[0]!)).toContain("Retrying (1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(stripAnsi(editor.render(120)[0]!)).toBe("─".repeat(120));
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
