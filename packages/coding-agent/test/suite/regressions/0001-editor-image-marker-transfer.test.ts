import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { Editor, type EditorComponent, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Container, TUI } from "../../../../tui/src/tui.ts";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { EditorFactory } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";

/**
 * Regression: switching editors (extension custom editor <-> default editor)
 * must not desynchronize pasted image attachments from their `[Image #N]`
 * markers. `pendingImages` lives on InteractiveMode so the bytes survive the
 * swap, but the marker registry and the `onImageMarkersChanged` subscription
 * live on the editor instance: without an explicit transfer step a marker
 * either becomes dead literal text (payload orphaned, the model sees
 * `[Image #1]` with nothing attached) or keeps firing nothing, so later deletes
 * never reach the reconciler.
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
	pendingImages: Map<number, ImageContent>;
	reconcilePendingImages: (order: number[]) => void;
	subscribeImageMarkers: (editor: EditorComponent) => void;
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

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

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
		pendingImages: new Map<number, ImageContent>(),
		reconcilePendingImages:
			prototypeMethod<(this: SetCustomEditorComponentThis, order: number[]) => void>("reconcilePendingImages"),
		subscribeImageMarkers:
			prototypeMethod<(this: SetCustomEditorComponentThis, editor: EditorComponent) => void>(
				"subscribeImageMarkers",
			),
		disposeActiveSelector: () => {},
	};
	fakeThis.editorContainer.addChild(defaultEditor);
	fakeThis.subscribeImageMarkers.call(fakeThis, defaultEditor);
	return fakeThis;
}

/** Minimal custom editor with no marker support at all (plain EditorComponent contract). */
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

describe("InteractiveMode.setCustomEditorComponent image-marker transfer", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("transfers markers and the registry to a marker-aware custom editor", () => {
		const fakeThis = makeFakeThis();
		const id = fakeThis.defaultEditor.insertImageMarker();
		fakeThis.pendingImages.set(id, image("AAA"));
		expect(fakeThis.defaultEditor.getText()).toBe("[Image #1]");

		const factory: EditorFactory = (tui, theme) => new Editor(tui as TUI, theme);
		callSetCustomEditorComponent(fakeThis, factory);

		const custom = fakeThis.editor as Editor;
		expect(custom).not.toBe(fakeThis.defaultEditor);
		expect(custom.getText()).toBe("[Image #1]");
		// Registry moved with the text, so the marker is still atomic and owned.
		expect(custom.getImageMarkerState().ids).toEqual([1]);
		expect(fakeThis.pendingImages.get(1)?.data).toBe("AAA");

		// A second paste inside the custom editor must not collide with id 1.
		expect(custom.insertImageMarker()).toBe(2);
	});

	test("keeps the reconciler wired to the custom editor so deletes drop the payload", () => {
		const fakeThis = makeFakeThis();
		const id = fakeThis.defaultEditor.insertImageMarker();
		fakeThis.pendingImages.set(id, image("AAA"));

		callSetCustomEditorComponent(fakeThis, (tui, theme) => new Editor(tui as TUI, theme));
		const custom = fakeThis.editor as Editor;

		// Backspace over the marker inside the custom editor must reach the
		// reconciler through the re-bound onImageMarkersChanged callback.
		custom.handleInput("\x7f");
		expect(custom.getText()).toBe("");
		expect(fakeThis.pendingImages.size).toBe(0);
	});

	test("drops orphaned attachments when the custom editor cannot own markers", () => {
		const fakeThis = makeFakeThis();
		const id = fakeThis.defaultEditor.insertImageMarker();
		fakeThis.pendingImages.set(id, image("AAA"));

		const plain = new PlainEditorComponent();
		callSetCustomEditorComponent(fakeThis, () => plain);

		expect(fakeThis.editor).toBe(plain);
		// The marker cannot stay atomic in a marker-unaware editor, so it must not
		// survive as dead literal text with a live attachment behind it.
		expect(plain.getText()).not.toContain("[Image #");
		expect(fakeThis.pendingImages.size).toBe(0);
	});

	test("restores markers and the registry when switching back to the default editor", () => {
		const fakeThis = makeFakeThis();
		const id = fakeThis.defaultEditor.insertImageMarker();
		fakeThis.pendingImages.set(id, image("AAA"));

		callSetCustomEditorComponent(fakeThis, (tui, theme) => new Editor(tui as TUI, theme));
		callSetCustomEditorComponent(fakeThis, undefined);

		expect(fakeThis.editor).toBe(fakeThis.defaultEditor);
		expect(fakeThis.defaultEditor.getText()).toBe("[Image #1]");
		expect(fakeThis.defaultEditor.getImageMarkerState().ids).toEqual([1]);
		expect(fakeThis.pendingImages.get(1)?.data).toBe("AAA");

		// And the callback is wired to the default editor again.
		fakeThis.defaultEditor.handleInput("\x7f");
		expect(fakeThis.pendingImages.size).toBe(0);
	});

	test("unset is a draft no-op when the default editor is already active", () => {
		const fakeThis = makeFakeThis();
		const id = fakeThis.defaultEditor.insertImageMarker();
		fakeThis.pendingImages.set(id, image("AAA"));

		callSetCustomEditorComponent(fakeThis, undefined);

		expect(fakeThis.editor).toBe(fakeThis.defaultEditor);
		expect(fakeThis.defaultEditor.getText()).toBe("[Image #1]");
		expect(fakeThis.pendingImages.get(1)?.data).toBe("AAA");
	});
});
