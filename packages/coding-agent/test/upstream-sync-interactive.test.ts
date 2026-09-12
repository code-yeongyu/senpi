import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Upstream sync (2026-09-12) guards for the interactive lane:
 *
 * - the fork's atomic `[Image #N]` marker/payload pairing and undo snapshots survive the adopted
 *   ASYNC clipboard stack (`readClipboardImage` / `readClipboardText` both resolve later);
 * - invalid theme JSON is still rejected by the fork's schema validator with its typed error even
 *   though upstream made validation an opt-in hook;
 * - the adopted configurable selector save binding is read when a selector is (re)opened.
 */

const clipboardImageMock = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
}));

const clipboardTextMock = vi.hoisted(() => ({
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard-image.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/clipboard-image.ts")>();
	return { ...original, readClipboardImage: clipboardImageMock.readClipboardImage };
});

vi.mock("../src/utils/clipboard.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/clipboard.ts")>();
	return { ...original, readClipboardText: clipboardTextMock.readClipboardText };
});

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { Editor, ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme, loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { processImage } from "../src/utils/image-process.ts";

type HandleClipboardPaste = (this: PasteReceiver) => Promise<void>;
type SubscribeImageMarkers = (this: PasteReceiver, editor: Editor) => void;
type Reconcile = (this: { pendingImages: Map<number, ImageContent> }, order: number[]) => void;
type TakeSubmissionImages = (this: { pendingImages: Map<number, ImageContent> }, text: string) => ImageContent[];

interface PasteReceiver {
	editor: Editor;
	pendingImages: Map<number, ImageContent>;
	reconcilePendingImages: (order: number[]) => void;
	ui: { requestRender: () => void };
	showStatus: ReturnType<typeof vi.fn>;
	sessionLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
	getSessionLogger: () => PasteReceiver["sessionLogger"];
	settingsManager: { getBlockImages: () => boolean; getImageAutoResize: () => boolean };
}

function prototypeMethod<T>(name: string): T {
	const handler = Reflect.get(InteractiveMode.prototype, name);
	if (typeof handler !== "function") throw new Error(`Expected InteractiveMode.${name}`);
	return handler as T;
}

const PNG_RED_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mN4YGBAEmIY1TCqYfhqAADPxkAQTDYcEAAAAABJRU5ErkJggg==";

function pngBytes(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

async function processedData(base64: string): Promise<string> {
	const processed = await processImage(pngBytes(base64), "image/png", { autoResizeImages: true });
	if (!processed.ok) throw new Error(`fixture image failed to process: ${processed.message}`);
	return processed.data;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A REAL pi-tui Editor wired through the REAL marker subscription, like production. */
function makePasteContext(): { context: PasteReceiver; editor: Editor } {
	const editor = new Editor(new TUI(new ProcessTerminal()), getEditorTheme());
	const sessionLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const context: PasteReceiver = {
		editor,
		pendingImages: new Map<number, ImageContent>(),
		reconcilePendingImages: (order: number[]) =>
			prototypeMethod<Reconcile>("reconcilePendingImages").call(context, order),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		sessionLogger,
		getSessionLogger: () => sessionLogger,
		settingsManager: { getBlockImages: () => false, getImageAutoResize: () => true },
	};
	prototypeMethod<SubscribeImageMarkers>("subscribeImageMarkers").call(context, editor);
	return { context, editor };
}

const BACKSPACE = "\x7f";
const UNDO = "\x1b[45;5u"; // Ctrl+-
const CTRL_S = "\x13";
const CTRL_R = "\x12";

describe("upstream sync: paste pairing across async clipboard reads", () => {
	beforeEach(() => {
		initTheme("dark");
		clipboardImageMock.readClipboardImage.mockReset();
		clipboardTextMock.readClipboardText.mockReset();
	});

	it("pairs the marker inserted after a deferred image read with its payload and survives undo", async () => {
		const { context, editor } = makePasteContext();
		const redData = await processedData(PNG_RED_BASE64);
		const imageRead = deferred<{ bytes: Uint8Array; mimeType: string } | null>();
		clipboardImageMock.readClipboardImage.mockReturnValueOnce(imageRead.promise);
		clipboardTextMock.readClipboardText.mockResolvedValue(null);

		// The paste is in flight while the user keeps typing: the marker must land where the
		// cursor is when the (async) clipboard read settles, never where the shortcut was pressed.
		const paste = prototypeMethod<HandleClipboardPaste>("handleClipboardPaste").call(context);
		editor.handleInput("abc");
		expect(context.pendingImages.size).toBe(0);
		imageRead.resolve({ bytes: pngBytes(PNG_RED_BASE64), mimeType: "image/png" });
		await paste;

		expect(editor.getText()).toBe("abc[Image #1]");
		expect(context.pendingImages.get(1)).toMatchObject({ type: "image", mimeType: "image/png", data: redData });
		expect(clipboardTextMock.readClipboardText).not.toHaveBeenCalled();

		// Deleting the marker drops its payload; undo restores BOTH halves of the pairing.
		editor.handleInput(BACKSPACE);
		expect(editor.getText()).toBe("abc");
		expect(context.pendingImages.size).toBe(0);
		editor.handleInput(UNDO);
		expect(editor.getText()).toBe("abc[Image #1]");
		expect([...context.pendingImages.keys()]).toEqual([1]);

		const images = prototypeMethod<TakeSubmissionImages>("takeSubmissionImages").call(context, editor.getText());
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ type: "image", data: redData, mimeType: "image/png" });
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("falls through to the deferred text read when the clipboard holds no image", async () => {
		const { context, editor } = makePasteContext();
		const textRead = deferred<string | null>();
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce(null);
		clipboardTextMock.readClipboardText.mockReturnValueOnce(textRead.promise);

		const paste = prototypeMethod<HandleClipboardPaste>("handleClipboardPaste").call(context);
		editor.handleInput("> ");
		textRead.resolve("pasted text");
		await paste;

		expect(editor.getText()).toBe("> pasted text");
		expect(context.pendingImages.size).toBe(0);
		expect(context.ui.requestRender).toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});

describe("upstream sync: theme JSON validation stays on by default", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function writeTheme(name: string, json: unknown): string {
		const dir = mkdtempSync(join(tmpdir(), "senpi-upstream-sync-theme-"));
		tempDirs.push(dir);
		const themePath = join(dir, `${name}.json`);
		writeFileSync(themePath, JSON.stringify(json));
		return themePath;
	}

	it("rejects a theme missing required color tokens with the fork validator's typed error", () => {
		const themePath = writeTheme("broken", { name: "broken", colors: { accent: "#ff0000" } });

		let thrown: unknown;
		try {
			loadThemeFromPath(themePath, "truecolor");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain('Invalid theme "');
		expect(message).toContain("Missing required color tokens:");
		for (const token of [
			"border",
			"text",
			"selectedBg",
			"toolDiffAdded",
			"syntaxKeyword",
			"thinkingOff",
			"bashMode",
		]) {
			expect(message).toContain(`  - ${token}`);
		}
		// Optional scrollbar tokens (adopted track/thumb foreground split) are never demanded.
		expect(message).not.toContain("  - scrollbarTrack");
		expect(message).not.toContain("  - scrollbarThumb");
	});

	it("rejects a theme whose color value has the wrong type", () => {
		const themePath = writeTheme("typed", { name: "typed", colors: { accent: true } });

		// The validator labels the document by its path and lists the offending JSON pointer.
		expect(() => loadThemeFromPath(themePath, "truecolor")).toThrow(
			/Invalid theme "[^"]*typed\.json"[\s\S]*\/colors\/accent: must be string/,
		);
	});
});

describe("upstream sync: selector save binding is read when a selector is reopened", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	function openThinkingSelector(saveDefault: (level: ThinkingLevel) => void): ThinkingSelectorComponent {
		return new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
			saveDefault,
		);
	}

	it("switches from the default chord to a rebound chord across reopen", () => {
		const firstSave = vi.fn<(level: ThinkingLevel) => void>();
		const first = openThinkingSelector(firstSave);
		expect(stripAnsi(first.render(80).join("\n"))).toContain("Ctrl+S to set as default");
		first.handleInput(CTRL_R);
		expect(firstSave).not.toHaveBeenCalled();
		first.handleInput(CTRL_S);
		expect(firstSave).toHaveBeenCalledWith("medium");

		// The user rebinds app.thinking.save; the next selector picks the new chord up on open.
		setKeybindings(new KeybindingsManager({ "app.thinking.save": "ctrl+r" }));
		const secondSave = vi.fn<(level: ThinkingLevel) => void>();
		const second = openThinkingSelector(secondSave);
		const hint = stripAnsi(second.render(80).join("\n"));
		expect(hint).toContain("Ctrl+R to set as default");
		expect(hint).not.toContain("Ctrl+S to set as default");
		second.handleInput(CTRL_S);
		expect(secondSave).not.toHaveBeenCalled();
		second.handleInput(CTRL_R);
		expect(secondSave).toHaveBeenCalledWith("medium");
	});
});
