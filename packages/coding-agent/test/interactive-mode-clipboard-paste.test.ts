import { describe, expect, it, vi } from "vitest";

/**
 * Regression: clipboard paste failures must never be silently swallowed.
 *
 * Field report (Discord 2026-07-30): the CLI appeared to freeze/misbehave
 * around clipboard image handling with zero trace. handleClipboardPaste's
 * catch block dropped every error, so permission failures, native-clipboard
 * errors, and tmp-file write failures were indistinguishable from "nothing
 * on the clipboard".
 *
 * The attachment cases below drive a REAL pi-tui `Editor` (headless
 * `ProcessTerminal`) wired through the REAL `subscribeImageMarkers`
 * notification path. The first version of this suite faked
 * `insertImageMarker` with a counter that never fired
 * `onImageMarkersChanged`, so the reconcile-before-set collision in the
 * multi-paste flow was structurally unreachable from the tests - exactly the
 * gap that let an always-broken multi-image path merge green. Never replace
 * the real editor here with a marker-unaware fake.
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

import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { Editor, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { processImage } from "../src/utils/image-process.ts";

type HandleClipboardPaste = (this: PasteReceiver) => Promise<void>;
type SubscribeImageMarkers = (this: PasteReceiver, editor: Editor) => void;
type Reconcile = (this: { pendingImages: Map<number, ImageContent> }, order: number[]) => void;
type TakeSubmissionImages = (this: { pendingImages: Map<number, ImageContent> }, text: string) => ImageContent[];

/** Borrowed-receiver shape for the private interactive-mode methods under test. */
interface PasteReceiver {
	editor: Editor;
	pendingImages: Map<number, ImageContent>;
	/** Stood in for the prototype method the notify handler resolves through `this`. */
	reconcilePendingImages: (order: number[]) => void;
	ui: { requestRender: () => void };
	showStatus: ReturnType<typeof vi.fn>;
	sessionLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
	getSessionLogger: () => PasteReceiver["sessionLogger"];
	settingsManager: { getBlockImages: () => boolean; getImageAutoResize: () => boolean };
	session?: unknown;
	lastInputWasPaste?: boolean;
}

function getPrototypeMethod<T>(name: string): T {
	const handler = Reflect.get(InteractiveMode.prototype, name);
	if (typeof handler !== "function") throw new Error(`Expected InteractiveMode.${name}`);
	return handler as T;
}

function getHandleClipboardPaste(): HandleClipboardPaste {
	return getPrototypeMethod<HandleClipboardPaste>("handleClipboardPaste");
}

function getSubscribeImageMarkers(): SubscribeImageMarkers {
	return getPrototypeMethod<SubscribeImageMarkers>("subscribeImageMarkers");
}

function getReconcile(): Reconcile {
	return getPrototypeMethod<Reconcile>("reconcilePendingImages");
}

function getTakeSubmissionImages(): TakeSubmissionImages {
	return getPrototypeMethod<TakeSubmissionImages>("takeSubmissionImages");
}

/**
 * Real 16x16 RGB PNGs (solid red / blue / green) so processImage() genuinely
 * decodes and normalizes three DISTINGUISHABLE payloads: the multi-paste
 * cases must be able to tell which image survived and which was destroyed or
 * mispaired.
 */
const PNG_RED_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mN4YGBAEmIY1TCqYfhqAADPxkAQTDYcEAAAAABJRU5ErkJggg==";
const PNG_BLUE_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mMwSHhAEmIY1TCqYfhqAADz/nAQ/ArooAAAAABJRU5ErkJggg==";
const PNG_GREEN_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mMwOBBAEmIY1TCqYfhqAAD/t0AQSkxbfAAAAABJRU5ErkJggg==";

function pngBytes(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

/** The base64 payload attachClipboardImage stores for a given clipboard bitmap. */
async function processedData(base64: string): Promise<string> {
	const processed = await processImage(pngBytes(base64), "image/png", { autoResizeImages: true });
	if (!processed.ok) throw new Error(`fixture image failed to process: ${processed.message}`);
	return processed.data;
}

let themeInitialized = false;

/** A REAL pi-tui Editor on a headless terminal - the same class production uses. */
function createRealEditor(): Editor {
	if (!themeInitialized) {
		initTheme("dark");
		themeInitialized = true;
	}
	return new Editor(new TUI(new ProcessTerminal()), getEditorTheme());
}

/**
 * Borrowed-prototype receiver whose editor is the real pi-tui `Editor`,
 * subscribed exactly like production (`subscribeImageMarkers` wires the
 * notify -> reconcile path and the undo payload mirroring).
 */
function makeContext(options: { blockImages?: boolean; autoResize?: boolean } = {}) {
	const editor = createRealEditor();
	const sessionLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const context: PasteReceiver = {
		editor,
		pendingImages: new Map<number, ImageContent>(),
		// The notify handler resolves `this.reconcilePendingImages` through the
		// receiver, exactly like a real InteractiveMode instance does through its
		// prototype - a plain object has no prototype chain, so stand in for it.
		reconcilePendingImages: (order: number[]) => getReconcile().call(context, order),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		sessionLogger,
		getSessionLogger: () => sessionLogger,
		// Borrowed-prototype call: a plain receiver does not inherit InteractiveMode's
		// `settingsManager` getter, so the fixture stands in for it directly.
		settingsManager: {
			getBlockImages: () => options.blockImages ?? false,
			getImageAutoResize: () => options.autoResize ?? true,
		},
	};
	getSubscribeImageMarkers().call(context, editor);
	return { context, editor };
}

/** Simulate one Ctrl+V image paste of the given bitmap into `receiver`. */
async function pasteImage(receiver: PasteReceiver, base64: string): Promise<void> {
	clipboardImageMock.readClipboardImage.mockResolvedValueOnce({ bytes: pngBytes(base64), mimeType: "image/png" });
	clipboardTextMock.readClipboardText.mockResolvedValue(null);
	await getHandleClipboardPaste().call(receiver);
}

const LINE_START = "\x01"; // Ctrl+A
const ARROW_LEFT = "\x1b[D";
const BACKSPACE = "\x7f";
const UNDO = "\x1b[45;5u"; // Ctrl+-

describe("InteractiveMode clipboard paste error surfacing", () => {
	it("surfaces a status message when clipboard image read fails", async () => {
		clipboardImageMock.readClipboardImage.mockRejectedValueOnce(new Error("pasteboard permission denied"));
		clipboardTextMock.readClipboardText.mockResolvedValue(null);
		const { context, editor } = makeContext();
		const insertText = vi.spyOn(editor, "insertTextAtCursor");

		await getHandleClipboardPaste().call(context);

		expect(insertText).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		const status = context.showStatus.mock.calls[0]?.[0];
		expect(String(status)).toContain("Clipboard paste failed");
		expect(String(status)).toContain("pasteboard permission denied");
		expect(context.sessionLogger.warn).toHaveBeenCalledWith(
			"clipboard_error",
			expect.objectContaining({ op: "paste", error: expect.stringContaining("pasteboard permission denied") }),
		);
	});

	it("surfaces a status message when clipboard text read fails after empty image", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce(null);
		clipboardTextMock.readClipboardText.mockRejectedValueOnce(new Error("text unavailable"));
		const { context } = makeContext();

		await getHandleClipboardPaste().call(context);

		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toContain("Clipboard paste failed");
	});

	it("stays quiet when the clipboard is simply empty", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce(null);
		clipboardTextMock.readClipboardText.mockResolvedValueOnce(null);
		const { context, editor } = makeContext();
		const insertText = vi.spyOn(editor, "insertTextAtCursor");

		await getHandleClipboardPaste().call(context);

		expect(context.showStatus).not.toHaveBeenCalled();
		expect(insertText).not.toHaveBeenCalled();
		expect(context.sessionLogger.warn).not.toHaveBeenCalled();
	});
});

/**
 * Regression: pasting a screenshot used to write the bytes to a temp file and
 * insert that path as literal text, so the model received an unreadable
 * `/var/folders/.../pi-clipboard-<uuid>.png` string and never the image. The
 * bytes must now travel in memory, keyed by the atomic `[Image #N]` marker id.
 */
describe("InteractiveMode clipboard paste image attachment", () => {
	it("attaches the image as a pending payload behind an atomic marker", async () => {
		const { context, editor } = makeContext();
		const insertMarker = vi.spyOn(editor, "insertImageMarker");
		const [redData] = await Promise.all([processedData(PNG_RED_BASE64)]);

		await pasteImage(context, PNG_RED_BASE64);

		expect(insertMarker).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("[Image #1]");

		expect(context.pendingImages.size).toBe(1);
		const entry = context.pendingImages.get(1);
		expect(entry).toBeDefined();
		expect(entry?.type).toBe("image");
		expect(entry?.mimeType).toBe("image/png");
		expect(entry?.data).toBe(redData);
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.sessionLogger.warn).not.toHaveBeenCalled();
	});

	it("never inserts a temp-file path for the pasted image", async () => {
		const { context, editor } = makeContext();

		await pasteImage(context, PNG_RED_BASE64);

		const inserted = editor.getText();
		expect(inserted).toContain("[Image #1]");
		expect(inserted).not.toContain("/tmp");
		expect(inserted).not.toContain("/var/folders");
		expect(inserted).not.toContain("pi-clipboard-");
	});

	it("keeps marker numbering and the payload map aligned across two pastes", async () => {
		const { context, editor } = makeContext();
		const insertMarker = vi.spyOn(editor, "insertImageMarker");
		const [redData, blueData] = await Promise.all([processedData(PNG_RED_BASE64), processedData(PNG_BLUE_BASE64)]);

		await pasteImage(context, PNG_RED_BASE64);
		await pasteImage(context, PNG_BLUE_BASE64);

		// THE load-bearing invariant: the integer N in `[Image #N]` is the
		// 1-based index of that image in the submitted images array. Two
		// ordinary in-order pastes must ship BOTH images.
		expect(insertMarker).toHaveBeenCalledTimes(2);
		expect(editor.getText()).toBe("[Image #1][Image #2]");
		expect([...context.pendingImages.keys()]).toEqual([1, 2]);

		const images = getTakeSubmissionImages().call(context, editor.getText());
		expect(images).toHaveLength(2);
		expect(images[0]).toMatchObject({ type: "image", data: redData, mimeType: "image/png" });
		expect(images[1]).toMatchObject({ type: "image", data: blueData, mimeType: "image/png" });
		expect(context.pendingImages.size).toBe(0);
	});

	it("pairs each marker with its own payload when a paste lands before an existing marker", async () => {
		const { context, editor } = makeContext();
		const [redData, blueData] = await Promise.all([processedData(PNG_RED_BASE64), processedData(PNG_BLUE_BASE64)]);

		await pasteImage(context, PNG_RED_BASE64);
		editor.handleInput(LINE_START); // cursor now sits BEFORE the first marker
		await pasteImage(context, PNG_BLUE_BASE64);

		// The visible numbers must stay canonical 1..k in reading order, so
		// `[Image #1]` is the pasted-at-the-front image and `[Image #2]` the
		// original one. A stale "[Image #2][Image #1]" text means the survivor
		// resolves to the WRONG attachment in look_at("[Image #1]").
		expect(editor.getText()).toBe("[Image #1][Image #2]");

		const images = getTakeSubmissionImages().call(context, editor.getText());
		expect(images).toHaveLength(2);
		expect(images[0]).toMatchObject({ type: "image", data: blueData });
		expect(images[1]).toMatchObject({ type: "image", data: redData });
	});

	it("restores the payload map when an undo brings a deleted marker back", async () => {
		const { context, editor } = makeContext();
		const [redData, blueData, greenData] = await Promise.all([
			processedData(PNG_RED_BASE64),
			processedData(PNG_BLUE_BASE64),
			processedData(PNG_GREEN_BASE64),
		]);

		// The F2 audit's exact reproduction: pending {1:A, 2:B, 3:C} behind
		// "[Image #1] [Image #2] [Image #3]".
		await pasteImage(context, PNG_RED_BASE64);
		editor.handleInput(" ");
		await pasteImage(context, PNG_BLUE_BASE64);
		editor.handleInput(" ");
		await pasteImage(context, PNG_GREEN_BASE64);
		expect(editor.getText()).toBe("[Image #1] [Image #2] [Image #3]");

		// Backspace over the MIDDLE marker (cursor is after #3; two left-arrow
		// crossings land right after #2, so backspace deletes marker #2 whole).
		// Correct intermediate state: {1:A, 2:C} after the survivor renumbers.
		editor.handleInput(ARROW_LEFT);
		editor.handleInput(ARROW_LEFT);
		editor.handleInput(BACKSPACE);
		// Deleting the middle marker leaves its two neighboring spaces adjacent.
		expect(editor.getText()).toBe("[Image #1]  [Image #2]");
		expect([...context.pendingImages.keys()]).toEqual([1, 2]);
		expect(context.pendingImages.get(2)?.data).toBe(greenData);

		// Undo must restore BOTH halves of the pairing: the marker text AND its
		// payload. Pre-fix, undo restored the text/registry but NOT the map, so
		// pending stayed {1:A, 2:C}: submit shipped 3 markers / 2 images,
		// "[Image #2]" resolved to C (B permanently lost) and "[Image #3]" was
		// unresolvable.
		editor.handleInput(UNDO);
		expect(editor.getText()).toBe("[Image #1] [Image #2] [Image #3]");
		expect([...context.pendingImages.keys()]).toEqual([1, 2, 3]);

		// Submit: every marker resolves to ITS OWN image, in order.
		const images = getTakeSubmissionImages().call(context, editor.getText());
		expect(images).toHaveLength(3);
		expect(images[0]).toMatchObject({ type: "image", data: redData });
		expect(images[1]).toMatchObject({ type: "image", data: blueData });
		expect(images[2]).toMatchObject({ type: "image", data: greenData });
	});

	it("drops the attachment when blockImages is enabled and tells the user why", async () => {
		clipboardTextMock.readClipboardText.mockResolvedValueOnce(null);
		const { context, editor } = makeContext({ blockImages: true });
		const insertMarker = vi.spyOn(editor, "insertImageMarker");
		const insertText = vi.spyOn(editor, "insertTextAtCursor");

		await pasteImage(context, PNG_RED_BASE64);

		// Pinned behavior: no marker, no attachment, no temp path - and a visible
		// status so the paste is never a silent no-op.
		expect(insertMarker).not.toHaveBeenCalled();
		expect(insertText).not.toHaveBeenCalled();
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toContain("Image paste blocked");
		expect(context.sessionLogger.warn).not.toHaveBeenCalled();
	});

	it("surfaces a status and attaches nothing when the image cannot be processed", async () => {
		const { context, editor } = makeContext();
		const insertMarker = vi.spyOn(editor, "insertImageMarker");
		const insertText = vi.spyOn(editor, "insertTextAtCursor");

		clipboardImageMock.readClipboardImage.mockResolvedValueOnce({
			bytes: new Uint8Array([1, 2, 3, 4]),
			mimeType: "image/tiff",
		});
		clipboardTextMock.readClipboardText.mockResolvedValue(null);
		await getHandleClipboardPaste().call(context);

		expect(insertMarker).not.toHaveBeenCalled();
		expect(insertText).not.toHaveBeenCalled();
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toContain("Image");
	});
});

/**
 * Regression: the reconciler keeps `pendingImages` aligned with the editor's
 * visible `[Image #N]` numbers. The editor reports the surviving PRE-renumber
 * ids in reading order, so the map must be re-keyed to 1..k by position -
 * otherwise a deleted marker orphans its payload and `[Image #1]` resolves to
 * the wrong (or a removed) image at submit.
 */
describe("InteractiveMode image-marker reconciliation", () => {
	function image(data: string): ImageContent {
		return { type: "image", data, mimeType: "image/png" };
	}

	it("renumbers surviving payloads to match the reported reading order", () => {
		const context = {
			pendingImages: new Map<number, ImageContent>([
				[1, image("AAA")],
				[2, image("BBB")],
			]),
		};

		// `[Image #1]` was deleted; the editor renumbered `[Image #2]` down to 1.
		getReconcile().call(context, [2]);

		expect([...context.pendingImages.keys()]).toEqual([1]);
		expect(context.pendingImages.get(1)?.data).toBe("BBB");
	});

	it("re-keys the very map object every holder captured, never a fresh identity", async () => {
		// handleClipboardPaste hands `pendingImages` BY REFERENCE into
		// attachClipboardImage's deps; a reconciler that reassigns the field
		// orphans that reference and the second paste in a turn writes into a
		// dead map - silently destroying the image.
		const { context, editor } = makeContext();
		const capturedByPasteDeps = context.pendingImages;

		await pasteImage(context, PNG_RED_BASE64);
		await pasteImage(context, PNG_BLUE_BASE64);

		expect(context.pendingImages).toBe(capturedByPasteDeps);
		expect(context.pendingImages.size).toBe(2);
		expect(editor.getText()).toBe("[Image #1][Image #2]");
	});

	it("drops every payload when all markers are gone", () => {
		const context = { pendingImages: new Map<number, ImageContent>([[1, image("AAA")]]) };

		getReconcile().call(context, []);

		expect(context.pendingImages.size).toBe(0);
	});

	it("ignores reported ids that have no pending payload (user-typed markers)", () => {
		const context = { pendingImages: new Map<number, ImageContent>([[2, image("BBB")]]) };

		// `[Image #1]` was typed by hand and owns no attachment.
		getReconcile().call(context, [1, 2]);

		expect([...context.pendingImages.keys()]).toEqual([2]);
		expect(context.pendingImages.get(2)?.data).toBe("BBB");
	});
});
