import {
	type Component,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import { type BtwHistoryViewEntry, BtwHistoryViewModel } from "./history-view-model.ts";

const SELECTED_PREFIX = "→ ";
const INACTIVE_PREFIX = "  ";
const FOOTER_HINT = "left/right: question   up/down: scroll   esc: close";
const FOOTER_LINE_COUNT = 1;
const MIN_LAYOUT_ROWS = 3;

export const BTW_HISTORY_OVERLAY_OPTIONS = { width: "90%", maxHeight: "80%", minWidth: 60, margin: 2 } as const;
export const BTW_HISTORY_OVERLAY_HEIGHT_RATIO = 0.8;
export const BTW_HISTORY_OVERLAY_CHROME_ROWS = 4;

export interface BtwHistoryLayout {
	readonly questionRows: number;
	readonly answerRows: number;
}

export function computeBtwHistoryLayout(input: {
	readonly terminalRows: number;
	readonly entryCount: number;
}): BtwHistoryLayout {
	const budget = Math.max(
		MIN_LAYOUT_ROWS,
		Math.floor(Math.max(0, input.terminalRows) * BTW_HISTORY_OVERLAY_HEIGHT_RATIO) - BTW_HISTORY_OVERLAY_CHROME_ROWS,
	);
	const maxQuestionRows = Math.max(0, budget - FOOTER_LINE_COUNT - 1);
	const questionRows = Math.min(Math.max(0, input.entryCount), maxQuestionRows);
	const answerRows = Math.max(1, budget - questionRows - FOOTER_LINE_COUNT);

	return { questionRows, answerRows };
}

function normalizeQuestion(question: string): string {
	return question.replace(/[\r\n]+/g, " ").trim();
}

function fitToWidth(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, "") : text;
}

function wrapAnswer(answer: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	return wrapTextWithAnsi(answer, safeWidth).map((line) => fitToWidth(line, safeWidth));
}

export class BtwHistoryPanel implements Component {
	private readonly entries: readonly BtwHistoryViewEntry[];
	private readonly model: BtwHistoryViewModel;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: undefined) => void;

	constructor(entries: readonly BtwHistoryViewEntry[], tui: TUI, theme: Theme, done: (result: undefined) => void) {
		this.entries = entries;
		this.model = new BtwHistoryViewModel(entries);
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.model.entryCount === 0) {
			this.model.setAnswerLineCount(0);
			this.model.setViewportHeight(0);
			return [this.theme.fg("muted", fitToWidth("No side questions yet.", safeWidth))];
		}

		const answerLines = wrapAnswer(this.model.selected?.answer ?? "", safeWidth);
		const layout = computeBtwHistoryLayout({
			terminalRows: this.tui.terminal.rows,
			entryCount: this.model.entryCount,
		});
		this.model.setAnswerLineCount(answerLines.length);
		this.model.setViewportHeight(layout.answerRows);

		const lines = this.renderQuestionRows(safeWidth, layout.questionRows);
		const answerStart = this.model.scrollOffset;
		lines.push(...answerLines.slice(answerStart, answerStart + layout.answerRows));
		lines.push(this.theme.fg("dim", fitToWidth(FOOTER_HINT, safeWidth)));

		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}

		let changed = false;
		if (matchesKey(data, Key.left)) {
			changed = this.model.selectPrevious();
		} else if (matchesKey(data, Key.right)) {
			changed = this.model.selectNext();
		} else if (matchesKey(data, Key.up)) {
			changed = this.model.scrollUp();
		} else if (matchesKey(data, Key.down)) {
			changed = this.model.scrollDown();
		}

		if (changed) this.tui.requestRender();
	}

	invalidate(): void {}

	private renderQuestionRows(width: number, rowCount: number): string[] {
		const rows: string[] = [];
		const startIndex = this.questionWindowStart(rowCount);
		const visibleEntries = this.entries.slice(startIndex, startIndex + rowCount);
		for (const [offset, entry] of visibleEntries.entries()) {
			const index = startIndex + offset;
			const isSelected = index === this.model.selectedIndex;
			const prefix = isSelected ? SELECTED_PREFIX : INACTIVE_PREFIX;
			const row = fitToWidth(`${prefix}/btw ${normalizeQuestion(entry.question)}`, width);
			rows.push(isSelected ? this.theme.fg("accent", row) : this.theme.fg("muted", row));
		}
		return rows;
	}

	private questionWindowStart(rowCount: number): number {
		if (rowCount <= 0) return 0;
		const maxStart = Math.max(0, this.entries.length - rowCount);
		return Math.min(this.model.selectedIndex, maxStart);
	}
}
