import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import type { KeybindingsManager } from "../../../keybindings.ts";
import { formatBtwQuestion, sanitizeBtwDisplayText } from "./display-text.ts";
import { type BtwHistoryViewEntry, BtwHistoryViewModel } from "./history-view-model.ts";

const FOOTER_HINT = "left/right: question   up/down: scroll   esc: close";
const FOOTER_LINE_COUNT = 1;

export const BTW_HISTORY_OVERLAY_OPTIONS = { width: "90%", maxHeight: "80%", minWidth: 60, margin: 2 } as const;
export const BTW_HISTORY_OVERLAY_HEIGHT_RATIO = 0.8;
export const BTW_HISTORY_OVERLAY_CHROME_ROWS = 4;

export interface BtwHistoryLayout {
	readonly questionRows: number;
	readonly answerRows: number;
}

interface BtwHistoryPanelOptions {
	readonly entries: readonly BtwHistoryViewEntry[];
	readonly tui: {
		readonly terminal: { readonly rows: number };
		requestRender(): void;
	};
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly done: (result: undefined) => void;
}

export function computeBtwHistoryLayout(input: {
	readonly terminalRows: number;
	readonly entryCount: number;
}): BtwHistoryLayout {
	const budget = Math.max(
		3,
		Math.floor(Math.max(0, input.terminalRows) * BTW_HISTORY_OVERLAY_HEIGHT_RATIO) - BTW_HISTORY_OVERLAY_CHROME_ROWS,
	);
	const maxQuestionRows = Math.max(0, budget - FOOTER_LINE_COUNT - 1);
	const questionRows = Math.min(Math.max(0, input.entryCount), maxQuestionRows);
	return { questionRows, answerRows: Math.max(1, budget - questionRows - FOOTER_LINE_COUNT) };
}

export function fitBtwHistoryRow(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, "") : text;
}

export class BtwHistoryPanel implements Component {
	readonly #entries: readonly BtwHistoryViewEntry[];
	readonly #model: BtwHistoryViewModel;
	readonly #tui: BtwHistoryPanelOptions["tui"];
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #done: (result: undefined) => void;

	constructor(options: BtwHistoryPanelOptions) {
		this.#entries = options.entries;
		this.#model = new BtwHistoryViewModel(options.entries);
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#done = options.done;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const selected = this.#model.selected;
		if (!selected) return [this.#theme.fg("muted", fitBtwHistoryRow("No side questions yet.", safeWidth))];

		const answerLines = wrapTextWithAnsi(sanitizeBtwDisplayText(selected.answer), safeWidth).map((line) =>
			fitBtwHistoryRow(line, safeWidth),
		);
		const layout = computeBtwHistoryLayout({
			terminalRows: this.#tui.terminal.rows,
			entryCount: this.#model.entryCount,
		});
		this.#model.setAnswerLineCount(answerLines.length);
		this.#model.setViewportHeight(layout.answerRows);
		const lines = this.#renderQuestions(safeWidth, layout.questionRows);
		lines.push(...answerLines.slice(this.#model.scrollOffset, this.#model.scrollOffset + layout.answerRows));
		lines.push(this.#theme.fg("dim", fitBtwHistoryRow(FOOTER_HINT, safeWidth)));
		return lines;
	}

	handleInput(data: string): void {
		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#done(undefined);
			return;
		}
		const changed = this.#keybindings.matches(data, "tui.editor.cursorLeft")
			? this.#model.selectPrevious()
			: this.#keybindings.matches(data, "tui.editor.cursorRight")
				? this.#model.selectNext()
				: this.#keybindings.matches(data, "tui.select.up")
					? this.#model.scrollUp()
					: this.#keybindings.matches(data, "tui.select.down") && this.#model.scrollDown();
		if (changed) this.#tui.requestRender();
	}

	invalidate(): void {}

	#renderQuestions(width: number, rowCount: number): string[] {
		const maxStart = Math.max(0, this.#entries.length - rowCount);
		const start = rowCount > 0 ? Math.min(this.#model.selectedIndex, maxStart) : 0;
		return this.#entries.slice(start, start + rowCount).map((entry, offset) => {
			const selected = start + offset === this.#model.selectedIndex;
			const row = fitBtwHistoryRow(`${selected ? "→" : " "} /btw ${formatBtwQuestion(entry.question)}`, width);
			return this.#theme.fg(selected ? "accent" : "muted", row);
		});
	}
}
