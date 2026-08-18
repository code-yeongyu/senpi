import { Editor, type EditorComponent, type EditorPasteState, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Container, TUI } from "../../../../tui/src/tui.ts";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { EditorFactory } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";

/**
 * Regression: switching editors (extension custom editor <-> default editor)
 * must not orphan large-paste markers. A destination editor without a paste
 * registry would keep the literal `[paste #N +M lines]` marker and silently
 * drop the pasted body from the submitted prompt.
 */

type SetCustomEditorComponentThis = {
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
	const descriptor = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, name);
	const method = descriptor?.value as T | undefined;
	if (!method) {
		throw new Error(`${name} is missing`);
	}
	return method;
}

function callSetCustomEditorComponent(
	fakeThis: SetCustomEditorComponentThis,
	factory: EditorFactory | undefined,
): void {
	const setCustomEditorComponent =
		prototypeMethod<(this: SetCustomEditorComponentThis, factory: EditorFactory | undefined) => void>(
			"setCustomEditorComponent",
		);
	setCustomEditorComponent.call(fakeThis, factory);
}

const PASTE_BODY = Array.from({ length: 18 }, (_, i) => `PASTE-BODY-LINE-${i + 1}`).join("\n");
const BRACKETED_PASTE = `\x1b[200~${PASTE_BODY}\x1b[201~`;

function makeFakeThis(): SetCustomEditorComponentThis {
	const ui = new TUI(new VirtualTerminal(120, 34));
	const defaultEditor = new Editor(ui, getEditorTheme());
	const fakeThis: SetCustomEditorComponentThis = {
		editorComponentFactory: undefined,
		editor: defaultEditor,
		defaultEditor,
		editorContainer: new Container(),
		chrome: undefined,
		autocompleteProvider: undefined,
		keybindings: new KeybindingsManager(),
		ui,
		getExpandedEditorText: prototypeMethod<(this: SetCustomEditorComponentThis) => string>("getExpandedEditorText"),
		disposeActiveSelector: () => {},
	};
	fakeThis.editorContainer.addChild(defaultEditor);
	return fakeThis;
}

/** Minimal custom editor without paste-state support (plain EditorComponent contract). */
class PlainEditorComponent implements EditorComponent {
	focused = false;
	private text = "";
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	handleInput(_data: string): void {}

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}
}

describe("InteractiveMode.setCustomEditorComponent paste transfer", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("transfers the paste registry to a paste-aware custom editor (markers stay collapsed)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);
		expect(fakeThis.defaultEditor.getText()).toMatch(/\[paste #1 \+\d+ lines\]/);

		const factory: EditorFactory = (tui, theme) => new Editor(tui as TUI, theme);
		callSetCustomEditorComponent(fakeThis, factory);

		const custom = fakeThis.editor as Editor;
		expect(custom).not.toBe(fakeThis.defaultEditor);
		// Marker stays collapsed (no UX regression) and still expands to the body
		expect(custom.getText()).toMatch(/\[paste #1 \+\d+ lines\]/);
		expect(custom.getExpandedText()).toBe(PASTE_BODY);

		// Submit through the wired onSubmit sends the full body, not the marker
		let submitted = "";
		custom.onSubmit = (text) => {
			submitted = text;
		};
		custom.handleInput("\r");
		expect(submitted).toBe(PASTE_BODY);
		expect(submitted).not.toContain("[paste #");
	});

	test("falls back to expanded text for a custom editor without paste-state support", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		const plain = new PlainEditorComponent();
		callSetCustomEditorComponent(fakeThis, () => plain);

		expect(fakeThis.editor).toBe(plain);
		// The plain editor cannot expand markers, so it must receive the body
		expect(plain.getText()).toBe(PASTE_BODY);
		expect(plain.getText()).not.toContain("[paste #");
	});

	test("restores the paste registry when switching back to the default editor", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		callSetCustomEditorComponent(fakeThis, (tui, theme) => new Editor(tui as TUI, theme));
		callSetCustomEditorComponent(fakeThis, undefined);

		expect(fakeThis.editor).toBe(fakeThis.defaultEditor);
		expect(fakeThis.defaultEditor.getText()).toMatch(/\[paste #1 \+\d+ lines\]/);
		expect(fakeThis.defaultEditor.getExpandedText()).toBe(PASTE_BODY);
	});

	test("round-trip through a plain editor keeps the pasted body (as literal text)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		callSetCustomEditorComponent(fakeThis, () => new PlainEditorComponent());
		callSetCustomEditorComponent(fakeThis, undefined);

		// Body was expanded on the way out and survives the way back
		expect(fakeThis.defaultEditor.getText()).toBe(PASTE_BODY);
	});

	test("expands from the paste snapshot when the source lacks getExpandedText", () => {
		const fakeThis = makeFakeThis();

		// Source editor exposes a paste snapshot but no expansion method
		// (getPasteState without getExpandedText / setPasteState).
		const sourceState: EditorPasteState = {
			pastes: new Map([[1, PASTE_BODY]]),
			pasteCounter: 1,
		};
		const snapshotOnly = new PlainEditorComponent();
		const snapshotSource = Object.assign(snapshotOnly, {
			getPasteState: (): EditorPasteState => sourceState,
		});
		snapshotSource.setText("before [paste #1 +18 lines] after");
		fakeThis.editor = snapshotSource;

		// Target has no setPasteState: the fallback must expand from the snapshot
		const target = new PlainEditorComponent();
		callSetCustomEditorComponent(fakeThis, () => target);

		expect(fakeThis.editor).toBe(target);
		expect(target.getText()).toBe(`before ${PASTE_BODY} after`);
		expect(target.getText()).not.toContain("[paste #");
	});

	test("does not hand collapsed markers to a target that cannot export them (setPasteState without getPasteState)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		// Target claims setPasteState but cannot export its registry later:
		// treating it as paste-aware would strand any paste made inside it.
		const importOnly = Object.assign(new PlainEditorComponent(), {
			setPasteState: (_state: EditorPasteState): void => {},
		});
		callSetCustomEditorComponent(fakeThis, () => importOnly);

		expect(fakeThis.editor).toBe(importOnly);
		expect(importOnly.getText()).toBe(PASTE_BODY);
		expect(importOnly.getText()).not.toContain("[paste #");
	});

	test("full-text consumers expand from the snapshot when the editor lacks getExpandedText", () => {
		const fakeThis = makeFakeThis();
		const sourceState: EditorPasteState = {
			pastes: new Map([[1, PASTE_BODY]]),
			pasteCounter: 1,
		};
		const snapshotOnly = Object.assign(new PlainEditorComponent(), {
			getPasteState: (): EditorPasteState => sourceState,
		});
		snapshotOnly.setText("before [paste #1 +18 lines] after");
		fakeThis.editor = snapshotOnly;

		expect(fakeThis.getExpandedEditorText.call(fakeThis)).toBe(`before ${PASTE_BODY} after`);
	});

	test("unset is a draft no-op when the default editor is already active (resetExtensionUI path)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);
		const markerText = fakeThis.defaultEditor.getText();
		const setTextSpy = vi.spyOn(fakeThis.defaultEditor, "setText");

		// No custom editor installed; resetExtensionUI() calls this unconditionally
		callSetCustomEditorComponent(fakeThis, undefined);

		expect(fakeThis.editor).toBe(fakeThis.defaultEditor);
		// The draft is untouched: marker stays collapsed, no setText churn
		expect(setTextSpy).not.toHaveBeenCalled();
		expect(fakeThis.defaultEditor.getText()).toBe(markerText);
		expect(fakeThis.defaultEditor.getExpandedText()).toBe(PASTE_BODY);
	});

	test("transferred paste state snapshots are content-exact (EditorPasteState contract)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		const state: EditorPasteState = fakeThis.defaultEditor.getPasteState();
		expect(state.pastes.get(1)).toBe(PASTE_BODY);
		expect(state.pasteCounter).toBe(1);
	});
});
