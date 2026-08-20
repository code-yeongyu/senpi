import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	type BtwSideEditorPort,
	BtwSidePanel,
	computeBtwSideLayout,
} from "../../src/core/extensions/builtin/btw/side-panel.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { testTheme } from "./history-search-fixtures.ts";

class FakeEditor implements BtwSideEditorPort {
	focused = false;
	disableSubmit = false;
	onSubmit: ((text: string) => void) | undefined;
	readonly inputs: string[] = [];
	readonly history: string[] = [];
	renderRows = 1;
	#text = "";

	getText(): string {
		return this.#text;
	}

	setText(text: string): void {
		this.#text = text;
	}

	addToHistory(text: string): void {
		this.history.push(text);
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(width: number): string[] {
		return Array.from({ length: this.renderRows }, (_, index) =>
			`${index === this.renderRows - 1 ? "> " : `row-${index} `}${this.#text}`.slice(0, width),
		);
	}

	invalidate(): void {}
}

function createPanel() {
	const editor = new FakeEditor();
	const callbacks = {
		onSubmit: vi.fn(),
		onToggle: vi.fn(),
		onClose: vi.fn(),
		onInterrupt: vi.fn(),
	};
	const tui = { terminal: { rows: 20 }, requestRender: vi.fn() };
	const keybindings = new KeybindingsManager({
		"app.clear": "ctrl+x",
		"app.interrupt": "ctrl+y",
		"tui.editor.pageUp": "ctrl+u",
		"tui.editor.pageDown": "ctrl+d",
	});
	const panel = new BtwSidePanel({
		entries: [{ question: "earlier question", answer: "earlier answer", timestamp: 1 }],
		tui,
		theme: testTheme,
		keybindings,
		callbacks,
		createEditor: () => editor,
	});
	return { panel, editor, callbacks, tui };
}

describe("BtwSidePanel", () => {
	it("renders only side history, current status, editor, and bounded configurable hints", () => {
		const { panel } = createPanel();
		panel.setParentStatus("working");
		panel.startTurn("current question");
		panel.appendText("current answer");

		const renderedRows = panel.render(50);
		const rendered = stripAnsi(renderedRows.join("\n"));

		expect(rendered).toContain("BTW side");
		expect(rendered).toContain("earlier question");
		expect(rendered).toContain("earlier answer");
		expect(rendered).toContain("current question");
		expect(rendered).toContain("current answer");
		expect(rendered).toContain("main working");
		expect(rendered).toContain("ctrl+x");
		expect(rendered).toContain("ctrl+y");
		expect(renderedRows.every((row) => visibleWidth(row) <= 50)).toBe(true);
		expect(renderedRows).toHaveLength(computeBtwSideLayout({ terminalRows: 20, editorRows: 1 }).totalRows);
	});

	it("forwards focus and submits a trimmed draft only while idle", () => {
		const { panel, editor, callbacks } = createPanel();
		panel.focused = true;
		editor.setText("  follow up  ");
		editor.onSubmit?.(editor.getText());

		expect(editor.focused).toBe(true);
		expect(callbacks.onSubmit).toHaveBeenCalledWith("follow up");
		expect(editor.getText()).toBe("");
		expect(editor.history).toEqual(["follow up"]);

		panel.startTurn("busy");
		editor.setText("keep this draft");
		editor.onSubmit?.(editor.getText());
		expect(callbacks.onSubmit).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("keep this draft");
		expect(editor.disableSubmit).toBe(true);

		panel.failTurn("provider failed");
		expect(editor.disableSubmit).toBe(false);
		expect(editor.getText()).toBe("keep this draft");
	});

	it("uses Ctrl+/ for switching and configured clear and interrupt bindings for side actions", () => {
		const { panel, callbacks } = createPanel();

		panel.handleInput("\x1f");
		panel.handleInput("\x1b[47;5u");
		panel.handleInput("\x18");
		panel.handleInput("\x19");

		expect(callbacks.onToggle).toHaveBeenCalledTimes(2);
		expect(callbacks.onClose).toHaveBeenCalledOnce();
		expect(callbacks.onInterrupt).toHaveBeenCalledOnce();
	});

	it("sanitizes model and configured text without injecting extra terminal rows", () => {
		const { panel } = createPanel();
		panel.startTurn("question\x1b[2J\nforged");
		panel.appendText("answer\x1b]52;c;AAAA\x07");
		panel.failTurn("failure\x1b[2J\nforged");

		const rows = panel.render(80);
		const rendered = stripAnsi(rows.join("\n"));

		expect(rendered).toContain("question forged");
		expect(rendered).toContain("answer");
		expect(rendered).toContain("failure forged");
		expect(rendered).not.toContain("52;c;AAAA");
		expect(rows.every((row) => !/[\r\n]/.test(row))).toBe(true);
	});

	it("caps a tall multiline editor so the overlay never exceeds terminal height", () => {
		const { panel, editor, tui } = createPanel();
		editor.renderRows = 30;

		const rows = panel.render(80);
		const rendered = stripAnsi(rows.join("\n"));

		expect(rows.length).toBeLessThanOrEqual(tui.terminal.rows);
		expect(rendered).toContain("row-0");
		expect(rendered).toContain("> ");
	});

	it("keeps switch, close, and cancel hints visible with default keys at eighty columns", () => {
		const editor = new FakeEditor();
		const panel = new BtwSidePanel({
			entries: [],
			tui: { terminal: { rows: 20 }, requestRender: vi.fn() },
			theme: testTheme,
			keybindings: new KeybindingsManager(),
			callbacks: { onSubmit: vi.fn(), onToggle: vi.fn(), onClose: vi.fn(), onInterrupt: vi.fn() },
			createEditor: () => editor,
		});

		const footer = stripAnsi(panel.render(80).at(-1) ?? "");

		expect(footer).toContain("ctrl+/ switch");
		expect(footer).toContain("ctrl+c close");
		expect(footer).toContain("esc cancel");
	});

	it("wraps long questions without silently dropping their tail", () => {
		const { panel } = createPanel();
		panel.startTurn(`question ${"middle ".repeat(12)}TAIL`);

		const rendered = stripAnsi(panel.render(40).join("\n"));

		expect(rendered).toContain("TAIL");
	});

	it("fits the empty-answer label inside very narrow terminals", () => {
		const { panel } = createPanel();
		panel.startTurn("q");

		const rows = panel.render(3);

		expect(rows.every((row) => visibleWidth(row) <= 3)).toBe(true);
	});

	it("clamps transcript paging and delegates PageUp to non-empty drafts", () => {
		const entries = Array.from({ length: 20 }, (_, index) => ({
			question: `question ${index}`,
			answer: `answer ${index}`,
			timestamp: index,
		}));
		const editor = new FakeEditor();
		const panel = new BtwSidePanel({
			entries,
			tui: { terminal: { rows: 20 }, requestRender: vi.fn() },
			theme: testTheme,
			keybindings: new KeybindingsManager(),
			callbacks: { onSubmit: vi.fn(), onToggle: vi.fn(), onClose: vi.fn(), onInterrupt: vi.fn() },
			createEditor: () => editor,
		});
		const pageUp = "\x1b[5~";
		const pageDown = "\x1b[6~";

		panel.render(80);
		for (let index = 0; index < 100; index++) panel.handleInput(pageUp);
		const atTop = panel.render(80);
		panel.handleInput(pageDown);
		expect(panel.render(80)).not.toEqual(atTop);

		editor.setText("draft");
		panel.handleInput(pageUp);
		expect(editor.inputs).toContain(pageUp);
	});
});
