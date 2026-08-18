import { Editor, type EditorComponent, type EditorPasteState, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Container, TUI } from "../../../../tui/src/tui.ts";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { EditorFactory } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";

type CustomEditorThis = {
	editorComponentFactory: EditorFactory | undefined;
	editor: EditorComponent;
	defaultEditor: Editor;
	editorContainer: Container;
	chrome: undefined;
	autocompleteProvider: undefined;
	keybindings: KeybindingsManager;
	ui: TUI;
	getExpandedEditorText: () => string;
	disposeActiveSelector(): void;
};

function prototypeMethod<T>(name: string): T {
	const method = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, name)?.value as T | undefined;
	if (!method) throw new Error(`${name} is missing`);
	return method;
}

function setCustomEditor(fakeThis: CustomEditorThis, factory: EditorFactory | undefined): void {
	prototypeMethod<(this: CustomEditorThis, value: EditorFactory | undefined) => void>("setCustomEditorComponent").call(
		fakeThis,
		factory,
	);
}

function makeFakeThis(): CustomEditorThis {
	const ui = new TUI(new VirtualTerminal(120, 34));
	const defaultEditor = new Editor(ui, getEditorTheme());
	const fakeThis: CustomEditorThis = {
		editorComponentFactory: undefined,
		editor: defaultEditor,
		defaultEditor,
		editorContainer: new Container(),
		chrome: undefined,
		autocompleteProvider: undefined,
		keybindings: new KeybindingsManager(),
		ui,
		getExpandedEditorText: prototypeMethod<(this: CustomEditorThis) => string>("getExpandedEditorText"),
		disposeActiveSelector: () => {},
	};
	fakeThis.editorContainer.addChild(defaultEditor);
	return fakeThis;
}

class PairedEditor implements EditorComponent {
	focused = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	private text = "";
	private pasteState: EditorPasteState = { pastes: new Map(), pasteCounter: 0 };

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	getPasteState(): EditorPasteState {
		return this.pasteState;
	}

	setPasteState(state: EditorPasteState): void {
		this.pasteState = state;
	}

	handleInput(data: string): void {
		if (data === "\r") this.onSubmit?.(this.getText());
	}

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}
}

class UnclearedExpandedEditor implements EditorComponent {
	focused = false;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	private text = "";

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	getExpandedText(): string {
		return `expanded:${this.text}`;
	}

	handleInput(data: string): void {
		if (data === "\r") this.onSubmit?.(this.text);
	}

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}
}

const PASTE_BODY = Array.from({ length: 18 }, (_, index) => `SUBMIT-BODY-${index + 1}`).join("\n");

describe("custom editor paste submission", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	test("expands paired paste state before forwarding custom editor submission", () => {
		const fakeThis = makeFakeThis();
		let submitted = "";
		fakeThis.defaultEditor.onSubmit = (text) => {
			submitted = text;
		};
		fakeThis.defaultEditor.handleInput(`\x1b[200~${PASTE_BODY}\x1b[201~`);

		setCustomEditor(fakeThis, () => new PairedEditor());
		fakeThis.editor.handleInput("\r");

		expect(submitted).toBe(PASTE_BODY);
	});

	test("forwards a real custom Editor value after submit clears live state", () => {
		const fakeThis = makeFakeThis();
		let submitted = "";
		fakeThis.defaultEditor.onSubmit = (text) => {
			submitted = text;
		};

		setCustomEditor(fakeThis, (ui) => new Editor(ui, getEditorTheme()));
		fakeThis.editor.setText("the typed prompt");
		fakeThis.editor.handleInput("\r");

		expect(submitted).toBe("the typed prompt");
	});

	test("preserves non-empty expanded text from an uncleared custom editor", () => {
		const fakeThis = makeFakeThis();
		let submitted = "";
		fakeThis.defaultEditor.onSubmit = (text) => {
			submitted = text;
		};

		setCustomEditor(fakeThis, () => new UnclearedExpandedEditor());
		fakeThis.editor.setText("raw prompt");
		fakeThis.editor.handleInput("\r");

		expect(submitted).toBe("expanded:raw prompt");
	});

	test("same-editor unset never computes expanded text", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(`\x1b[200~${PASTE_BODY}\x1b[201~`);
		const expandSpy = vi.spyOn(fakeThis.defaultEditor, "getExpandedText");

		setCustomEditor(fakeThis, undefined);

		expect(expandSpy).not.toHaveBeenCalled();
	});
});
