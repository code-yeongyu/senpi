import { type Component, type Focusable, Key, matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import type { KeybindingsManager } from "../../../keybindings.ts";
import { formatBtwQuestion } from "./display-text.ts";
import type { BtwHistoryEntry } from "./history.ts";
import type { BtwSideCallbacks, BtwSidePanelPort } from "./side-controller.ts";
import { computeBtwSideLayout, fitBtwSideRow, formatBtwSideFooter, renderBtwSideTurn } from "./side-panel-render.ts";
import type { BtwSideEditorPort, BtwSidePanelOptions, BtwSidePanelTui } from "./side-panel-types.ts";

export { computeBtwSideLayout } from "./side-panel-render.ts";
export type { BtwSideEditorPort } from "./side-panel-types.ts";
export const BTW_SIDE_OVERLAY_OPTIONS = { width: "100%", maxHeight: "100%", margin: 0 } as const;
const BTW_SIDE_DISPLAY_HISTORY_LIMIT = 20;

interface ActiveTurn {
	readonly question: string;
	answer: string;
	status: "streaming" | "error" | "aborted";
	detail: string;
}

export class BtwSidePanel implements Component, Focusable, BtwSidePanelPort {
	readonly #entries: BtwHistoryEntry[];
	readonly #tui: BtwSidePanelTui;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #callbacks: BtwSideCallbacks;
	readonly #editor: BtwSideEditorPort;
	#turn: ActiveTurn | undefined;
	#parentStatus: "working" | "idle" = "idle";
	#scrollOffset = 0;
	#maxScrollOffset = 0;
	#scrollPageSize = 1;

	constructor(options: BtwSidePanelOptions) {
		this.#entries = options.entries.slice(-BTW_SIDE_DISPLAY_HISTORY_LIMIT);
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#callbacks = options.callbacks;
		this.#editor = options.createEditor();
		this.#editor.onSubmit = (text) => this.#submit(text);
	}

	get focused(): boolean {
		return this.#editor.focused;
	}

	set focused(focused: boolean) {
		this.#editor.focused = focused;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const allEditorRows = this.#editor.render(safeWidth);
		const totalRows = Math.max(5, Math.floor(this.#tui.terminal.rows));
		const editorRowLimit = Math.max(1, totalRows - 3);
		const editorRows =
			allEditorRows.length <= editorRowLimit
				? allEditorRows
				: [allEditorRows[0] ?? "", ...allEditorRows.slice(-(editorRowLimit - 1))];
		const layout = computeBtwSideLayout({
			terminalRows: this.#tui.terminal.rows,
			editorRows: editorRows.length,
		});
		const transcript = this.#transcriptRows(safeWidth);
		const maxStart = Math.max(0, transcript.length - layout.transcriptRows);
		this.#maxScrollOffset = maxStart;
		this.#scrollPageSize = Math.max(1, layout.transcriptRows - 1);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxStart);
		const start = Math.max(0, maxStart - this.#scrollOffset);
		const visibleTranscript = transcript.slice(start, start + layout.transcriptRows);
		const transcriptPadding = Array.from({ length: layout.transcriptRows - visibleTranscript.length }, () => "");
		const status = this.#statusText();
		return [
			fitBtwSideRow(
				`${this.#theme.fg("accent", this.#theme.bold("BTW side"))} ${this.#theme.fg("dim", `· main ${this.#parentStatus}`)}`,
				safeWidth,
			),
			...transcriptPadding,
			...visibleTranscript,
			fitBtwSideRow(this.#theme.fg(status.kind, status.text), safeWidth),
			...editorRows.map((row) => fitBtwSideRow(row, safeWidth)),
			fitBtwSideRow(this.#theme.fg("dim", formatBtwSideFooter(this.#keybindings)), safeWidth),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("_")) || matchesKey(data, Key.ctrl("/"))) {
			this.#callbacks.onToggle();
			return;
		}
		if (this.#keybindings.matches(data, "app.clear")) {
			this.#callbacks.onClose();
			return;
		}
		if (this.#keybindings.matches(data, "app.interrupt")) {
			this.#callbacks.onInterrupt();
			return;
		}
		if (this.#keybindings.matches(data, "tui.editor.pageUp")) {
			if (this.#editor.getText().length > 0) {
				this.#editor.handleInput(data);
				return;
			}
			this.#scrollOffset = Math.min(this.#maxScrollOffset, this.#scrollOffset + this.#scrollPageSize);
			this.#tui.requestRender();
			return;
		}
		if (this.#keybindings.matches(data, "tui.editor.pageDown")) {
			if (this.#editor.getText().length > 0) {
				this.#editor.handleInput(data);
				return;
			}
			this.#scrollOffset = Math.max(0, this.#scrollOffset - this.#scrollPageSize);
			this.#tui.requestRender();
			return;
		}
		this.#editor.handleInput(data);
	}

	startTurn(question: string): void {
		this.#turn = { question: formatBtwQuestion(question), answer: "", status: "streaming", detail: "" };
		this.#editor.disableSubmit = true;
		this.#scrollOffset = 0;
		this.#tui.requestRender();
	}

	appendText(delta: string): void {
		if (this.#turn?.status !== "streaming") return;
		this.#turn.answer += delta;
		this.#tui.requestRender();
	}

	completeTurn(entry: BtwHistoryEntry): void {
		this.#entries.push(entry);
		if (this.#entries.length > BTW_SIDE_DISPLAY_HISTORY_LIMIT) this.#entries.shift();
		this.#turn = undefined;
		this.#editor.disableSubmit = false;
		this.#scrollOffset = 0;
		this.#tui.requestRender();
	}

	failTurn(message: string): void {
		if (this.#turn !== undefined) {
			this.#turn.status = "error";
			this.#turn.detail = formatBtwQuestion(message);
		}
		this.#editor.disableSubmit = false;
		this.#tui.requestRender();
	}

	abortTurn(): void {
		if (this.#turn !== undefined) this.#turn.status = "aborted";
		this.#editor.disableSubmit = false;
		this.#tui.requestRender();
	}

	setParentStatus(status: "working" | "idle"): void {
		this.#parentStatus = status;
		this.#tui.requestRender();
	}

	invalidate(): void {
		this.#editor.invalidate();
	}

	#submit(rawText: string): void {
		if (this.#editor.disableSubmit) return;
		const question = rawText.trim();
		if (question.length === 0) return;
		this.#editor.addToHistory?.(question);
		this.#editor.setText("");
		this.#callbacks.onSubmit(question);
	}

	#statusText(): { kind: "dim" | "error"; text: string } {
		if (this.#turn?.status === "streaming") return { kind: "dim", text: "answering…" };
		if (this.#turn?.status === "error") return { kind: "error", text: `error: ${this.#turn.detail}` };
		if (this.#turn?.status === "aborted") return { kind: "dim", text: "answer cancelled" };
		return { kind: "dim", text: "Ask a side question without changing the main conversation." };
	}

	#transcriptRows(width: number): string[] {
		const rows = this.#entries.flatMap((entry) =>
			renderBtwSideTurn({ question: entry.question, answer: entry.answer, width, theme: this.#theme }),
		);
		if (this.#turn !== undefined) {
			rows.push(
				...renderBtwSideTurn({
					question: this.#turn.question,
					answer: this.#turn.answer,
					width,
					theme: this.#theme,
				}),
			);
		}
		return rows;
	}
}
