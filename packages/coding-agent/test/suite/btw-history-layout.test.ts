import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sanitizeBtwDisplayText } from "../../src/core/extensions/builtin/btw/display-text.ts";
import {
	BTW_HISTORY_OVERLAY_CHROME_ROWS,
	BTW_HISTORY_OVERLAY_HEIGHT_RATIO,
	BtwHistoryPanel,
	computeBtwHistoryLayout,
	fitBtwHistoryRow,
} from "../../src/core/extensions/builtin/btw/history-panel.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { testTheme } from "./history-search-fixtures.ts";

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

	it("removes terminal control sequences while preserving display whitespace", () => {
		const text =
			"question\x1b[2J\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\\x1b]52;c;AAAA\x07\x07\nanswer\ttext";

		expect(sanitizeBtwDisplayText(text)).toBe("questionlink\nanswer\ttext");
	});

	it("makes DCS, APC, C1, and unterminated escape payloads inert", () => {
		const text = "a\x1bPtmux;payload\x1b\\b\x1b_app-data\x07c\x9d52;c;AAAA\x9cd\x1b]unterminated";

		const sanitized = sanitizeBtwDisplayText(text);

		expect(sanitized).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
		expect(sanitized).toContain("payload");
		expect(sanitized).toContain("terminated");
	});

	it("uses remapped selection, scrolling, and cancel keybindings", () => {
		const tui = { terminal: { rows: 8 }, requestRender: vi.fn() };
		const done = vi.fn();
		const panel = new BtwHistoryPanel({
			entries: [
				{ question: "first", answer: "first answer" },
				{ question: "second", answer: "line 01\nline 02\nline 03" },
			],
			tui,
			theme: testTheme,
			keybindings: new KeybindingsManager({
				"tui.editor.cursorLeft": "ctrl+h",
				"tui.editor.cursorRight": "ctrl+l",
				"tui.select.up": "ctrl+k",
				"tui.select.down": "ctrl+j",
				"tui.select.cancel": "ctrl+x",
			}),
			done,
		});
		const initial = stripAnsi(panel.render(80).join("\n"));
		expect(initial).toContain("ctrl+h/ctrl+l: question");
		expect(initial).toContain("ctrl+k/ctrl+j: scroll");
		expect(initial).toContain("ctrl+x: close");

		panel.handleInput("\x0c");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("→ /btw second");
		panel.handleInput("\n");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("line 02");
		panel.handleInput("\x18");
		expect(done).toHaveBeenCalledOnce();
	});

	it("removes terminal controls from configured footer key labels", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-btw-keybindings-"));
		try {
			writeFileSync(
				join(agentDir, "keybindings.json"),
				JSON.stringify({ "tui.select.cancel": "\x1b]52;c;AAAA\x07ctrl+x" }),
			);
			const panel = new BtwHistoryPanel({
				entries: [{ question: "question", answer: "answer" }],
				tui: { terminal: { rows: 8 }, requestRender: vi.fn() },
				theme: testTheme,
				keybindings: KeybindingsManager.create(agentDir),
				done: vi.fn(),
			});

			const raw = panel.render(120).join("\n");
			const rendered = stripAnsi(raw);

			expect(rendered).toContain("ctrl+x: close");
			expect(raw).not.toContain("\x1b]52");
			expect(raw).not.toContain("\x07");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
