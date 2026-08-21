import { describe, expect, it, vi } from "vitest";

/**
 * Submission-channel coverage for pasted images: the `[Image #N]` markers the
 * paste handler inserts must resolve, at submit time, into the images array
 * that rides PromptOptions alongside the text - on EVERY submission surface:
 * the normal onInputCallback/getUserInput channel, the streaming/steer
 * branch, and Alt+Enter (handleFollowUp), whose non-streaming leg cannot
 * widen the public onSubmit(text) API and must hand the images over
 * out-of-band instead.
 *
 * Resolution must read ONLY the submitted text plus the pendingImages map:
 * pi-tui's Editor.submitValue() has already reset the editor and cleared its
 * registries before onSubmit fires, so live editor state is empty by then.
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

vi.mock("../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { Editor, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { processImage } from "../src/utils/image-process.ts";

/** The widened submission-channel payload: text plus images resolved from markers. */
type UserSubmission = { text: string; images?: ImageContent[]; pendingEchoId: string };

function createEchoControllerStub() {
	let nextId = 0;
	return {
		begin: vi.fn(() => `pending-test-${++nextId}`),
		promptOptions: vi.fn(() => ({ preflightResult: vi.fn(), promptDisposition: vi.fn() })),
		reject: vi.fn(),
	};
}

type MockFn = ReturnType<typeof vi.fn>;

interface FakeEditor {
	getText: MockFn;
	setText: MockFn;
	addToHistory: MockFn;
	insertImageMarker: MockFn;
	insertTextAtCursor: MockFn;
	onSubmit?: (text: string) => void | Promise<void>;
	onImageMarkersChanged?: (order: number[]) => void;
}

interface FakeSession {
	isCompacting: boolean;
	isStreaming: boolean;
	isBashRunning: boolean;
	prompt: MockFn;
	reserveQueuedInputOrder: MockFn;
	extensionRunner: { getCommand: (name: string) => unknown };
	modelRuntime: { getError: () => string | undefined; refresh: () => Promise<unknown> };
	fallbackValidationWarnings: readonly string[];
}

interface ModeContext {
	defaultEditor: FakeEditor;
	editor: FakeEditor;
	session: FakeSession;
	pendingImages: Map<number, ImageContent>;
	optimisticUserEchoes: ReturnType<typeof createEchoControllerStub>;
	compactionQueuedMessages: { text: string; mode: string; enqueueOrder: number }[];
	pendingUserInputs: UserSubmission[];
	onInputCallback?: (input: UserSubmission) => void;
	preResolvedSubmissionImages?: ImageContent[];
	settingsManager: { getBlockImages: () => boolean; getImageAutoResize: () => boolean };
	sessionLogger: { warn: MockFn };
	getSessionLogger: () => ModeContext["sessionLogger"];
	ui: { requestRender: () => void };
	showStatus: MockFn;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	hideShortcutOverlay: () => void;
	flushPendingBashComponents: () => void;
	updatePendingMessagesDisplay: () => void;
	updateEditorBorderColor: () => void;
	handleModelCommand: (searchTerm?: string) => Promise<void>;
	handleBashCommand: (command: string, excluded: boolean) => Promise<void>;
	lastEditorText: string;
	isBashMode: boolean;
	options: Record<string, never>;
	version: string;
	init: () => Promise<void>;
	checkForPackageUpdates: () => Promise<string[]>;
	checkTmuxSetup: () => Promise<string | undefined>;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	showNewVersionNotification: (version: unknown) => void;
	showPackageUpdateNotification: (packages: unknown) => void;
	showRiskyMainModelWarning: () => void;
	/**
	 * Real production helpers, bound to the fake receiver (a plain object has
	 * no prototype chain to resolve private methods through). Missing helpers
	 * stay undefined so a tree without the implementation fails on assertions
	 * rather than crashing the harness.
	 */
	takeSubmissionImages?: (submittedText: string) => ImageContent[];
	reconcilePendingImages?: (order: number[]) => void;
	queueCompactionSubmission?: (text: string, mode: "steer" | "followUp") => void;
	queueCompactionMessage?: (text: string, mode: "steer" | "followUp", droppedImageCount?: number) => void;
	getUserInput?: () => Promise<UserSubmission>;
	isExtensionCommand?: (text: string) => boolean;
	getExpandedEditorText?: () => string;
}

type ModePrototype = {
	setupEditorSubmitHandler(this: ModeContext): void;
	getUserInput(this: ModeContext): Promise<UserSubmission>;
	run(this: ModeContext): Promise<void>;
	handleFollowUp(this: ModeContext): Promise<void>;
	handleClipboardPaste(this: ModeContext): Promise<void>;
	reconcilePendingImages(this: ModeContext, order: number[]): void;
	subscribeImageMarkers(this: ModeContext, editor: unknown): void;
	queueCompactionSubmission(this: ModeContext, text: string, mode: "steer" | "followUp"): void;
	queueCompactionMessage(
		this: ModeContext,
		text: string,
		mode: "steer" | "followUp",
		droppedImageCount?: number,
	): void;
	takeSubmissionImages(this: ModeContext, submittedText: string): ImageContent[];
	isExtensionCommand(this: ModeContext, text: string): boolean;
	getExpandedEditorText(this: ModeContext): string;
};

const proto = InteractiveMode.prototype as unknown as ModePrototype;

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

/**
 * A real 16x16 RGB PNG so processImage()'s decoder runs the production
 * normalization path (mirrors the clipboard-paste fixture).
 */
const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAB0klEQVR4nA3LoQ6FIABAURrBjabJ4mjMYtLGZqDRCGw0TBS67QY63c5/vnf6EUIgBUowC1aBFhjBIbgEVuAEXhAESZAFRSDEhJxQE/PEOqEnzMQxcU3YCTfhJ8JEmsgTZfqHBbmgFuaFdUEvmIVj4VqwC27BL4SFtJAXyvIPG3JDbcwb64beMBvHxrVhN9yG3wgbaSNvlO0fduSO2pl31h29Y3aOnWvH7rgdvzN20k7eKfs/nMgTdTKfrCv6xJwcJ9eJPXEn/iScpJN8Us5/uJE36ma+WW/0jbk5bq4be+Nu/E24STf5ptz/4JEe5Zk9q0d7jOfwXB7rcRZ7vCZ7kyZ7i/yEiIyoyR9aIjpjIEbkSNuIiPhIiKZIjJf7Dg3xQD/PD+qAfzMPxcD3YB/fgH8JDesgP5fmHiqyoylxZK7piKkflqtiKq/hKqKRKrpT6Dy/yRb3ML+uLfjEvx8v1Yl/ci38pa+kpS/3uXwyoRpzY23ohmkcjathZG7hG6GRGrlR2j90ZEd15O7a0R3TOTpXx3Zcx3dCJ3Vyp/R/+JA/6l+WD/0h/k4Pq4P++E+/Ef4SB/5o3z/MJADNZgH60APzOAYXAM7cAM/CIM0yIMy+AEIbAcQK3fUWgAAAABJRU5ErkJggg==";

function samplePngBytes(): Uint8Array {
	return new Uint8Array(Buffer.from(SAMPLE_PNG_BASE64, "base64"));
}

function createModeContext(): ModeContext {
	const sessionLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const editor: FakeEditor = {
		getText: vi.fn(() => ""),
		setText: vi.fn(() => {}),
		addToHistory: vi.fn(),
		insertImageMarker: vi.fn(() => 1),
		insertTextAtCursor: vi.fn(),
		onImageMarkersChanged: undefined,
	};
	const session: FakeSession = {
		isCompacting: false,
		isStreaming: false,
		isBashRunning: false,
		prompt: vi.fn(async () => {}),
		reserveQueuedInputOrder: vi.fn(() => 0),
		extensionRunner: { getCommand: vi.fn(() => undefined) },
		modelRuntime: { getError: vi.fn(() => undefined), refresh: vi.fn(async () => undefined) },
		fallbackValidationWarnings: [],
	};
	const context: ModeContext = Object.assign(
		{
			defaultEditor: {} as FakeEditor,
			editor,
			session,
			pendingImages: new Map<number, ImageContent>(),
			optimisticUserEchoes: createEchoControllerStub(),
			compactionQueuedMessages: [],
			pendingUserInputs: [] as UserSubmission[],
			onInputCallback: undefined,
			preResolvedSubmissionImages: undefined,
			settingsManager: {
				getBlockImages: () => false,
				getImageAutoResize: () => true,
			},
			sessionLogger,
			getSessionLogger: () => sessionLogger,
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			hideShortcutOverlay: vi.fn(),
			flushPendingBashComponents: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			handleModelCommand: vi.fn(async () => {}),
			handleBashCommand: vi.fn(async () => {}),
			lastEditorText: "",
			isBashMode: false,
			options: {},
			version: "test",
			init: vi.fn(async () => {}),
			checkForPackageUpdates: vi.fn(async (): Promise<string[]> => []),
			checkTmuxSetup: vi.fn(async () => undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
			showNewVersionNotification: vi.fn(),
			showPackageUpdateNotification: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
		},
		{} as ModeContext,
	);
	// Bind the REAL production helpers onto the fake receiver (a plain object
	// has no prototype chain to resolve private methods through). Missing
	// helpers stay undefined so a tree without the implementation fails on
	// assertions rather than crashing the harness.
	for (const method of [
		"takeSubmissionImages",
		"isExtensionCommand",
		"getExpandedEditorText",
		"getUserInput",
	] as const) {
		const real = proto[method] as unknown as ((this: ModeContext, ...args: never[]) => unknown) | undefined;
		if (typeof real === "function") {
			context[method] = real.bind(context) as never;
		}
	}

	// Mirror the real editor: clearing the text prunes every marker and fires
	// onImageMarkersChanged([]), which the reconciler answers by DESTROYING
	// pendingImages. Any submission path that resolves images after such a
	// setText loses the attachment.
	editor.setText = vi.fn((text: string) => {
		if (text === "") editor.onImageMarkersChanged?.([]);
	});
	editor.onImageMarkersChanged = (order: number[]) => {
		proto.reconcilePendingImages.call(context, order);
	};
	// The real subscribeImageMarkers resolves this.reconcilePendingImages
	// through the receiver; a plain object has no prototype chain, so stand in.
	context.reconcilePendingImages = (order: number[]) => proto.reconcilePendingImages.call(context, order);
	context.queueCompactionSubmission = (text, mode) => proto.queueCompactionSubmission.call(context, text, mode);
	context.queueCompactionMessage = (text, mode, droppedImageCount) =>
		proto.queueCompactionMessage.call(context, text, mode, droppedImageCount);
	return context;
}

/** Install the production submit handler; optionally let this.editor BE the default editor. */
function prepareSubmitHandler(context: ModeContext, options: { shareEditor?: boolean } = {}): void {
	if (options.shareEditor) context.defaultEditor = context.editor;
	proto.setupEditorSubmitHandler.call(context);
}

function submit(context: ModeContext, text: string): Promise<void> {
	const handler = context.defaultEditor.onSubmit;
	if (!handler) throw new Error("onSubmit handler not installed");
	return Promise.resolve(handler(text));
}

/** Start the real getUserInput() so the widened channel can be observed end-to-end. */
function beginUserInput(context: ModeContext): Promise<UserSubmission> {
	return proto.getUserInput.call(context);
}

/** Distinct solid-color 16x16 PNGs so mispairing is observable, not just count loss. */
const PNG_RED_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mN4YGBAEmIY1TCqYfhqAADPxkAQTDYcEAAAAABJRU5ErkJggg==";
const PNG_BLUE_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mMwSHhAEmIY1TCqYfhqAADz/nAQ/ArooAAAAABJRU5ErkJggg==";

function pngBytes(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

async function processedData(base64: string): Promise<string> {
	const processed = await processImage(pngBytes(base64), "image/png", { autoResizeImages: true });
	if (!processed.ok) throw new Error(`fixture image failed to process: ${processed.message}`);
	return processed.data;
}

let themeInitialized = false;

/** Simulate one Ctrl+V image paste of the given bitmap into `context`. */
async function pasteImage(context: ModeContext, base64: string): Promise<void> {
	clipboardImageMock.readClipboardImage.mockResolvedValueOnce({ bytes: pngBytes(base64), mimeType: "image/png" });
	clipboardTextMock.readClipboardText.mockResolvedValue(null);
	await proto.handleClipboardPaste.call(context);
}

/**
 * A ModeContext whose editor is the REAL pi-tui `Editor` on a headless
 * terminal, subscribed exactly like production. The fake-editor harness above
 * cannot exercise the notify path inside `insertImageMarker` - the fake's
 * `insertImageMarker` never fires `onImageMarkersChanged` - and that blind
 * spot is exactly how a broken multi-image flow shipped green.
 */
function createRealEditorContext(): { context: ModeContext; editor: Editor } {
	if (!themeInitialized) {
		initTheme("dark");
		themeInitialized = true;
	}
	const context = createModeContext();
	const editor = new Editor(new TUI(new ProcessTerminal()), getEditorTheme());
	context.editor = editor as unknown as FakeEditor;
	proto.subscribeImageMarkers.call(context, editor);
	return { context, editor };
}

describe("InteractiveMode image submission - normal channel", () => {
	it("delivers a submitted image through the real run() main loop into session.prompt", async () => {
		const pending = image("QUFBQQ==");
		const stop = new Error("stop interactive loop");
		const context = createModeContext();
		context.session.prompt = vi.fn(async () => {
			throw stop;
		});
		context.showError = vi.fn(() => {
			throw stop;
		});
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		const runPromise = proto.run.call(context);
		await submit(context, "look at [Image #1]");
		await expect(runPromise).rejects.toBe(stop);

		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [promptText, promptOptions] = context.session.prompt.mock.calls[0] as [
			string,
			{ streamingBehavior?: string; images?: ImageContent[] },
		];
		expect(promptText).toBe("look at [Image #1]");
		expect(promptOptions?.streamingBehavior).toBe("steer");
		expect(promptOptions?.images).toHaveLength(1);
		expect(promptOptions?.images?.[0]).toMatchObject({
			type: "image",
			data: pending.data,
			mimeType: pending.mimeType,
		});
	});

	it("passes NO images key when the main loop drains plain text", async () => {
		const stop = new Error("stop interactive loop");
		const context = createModeContext();
		context.session.prompt = vi.fn(async () => {
			throw stop;
		});
		context.showError = vi.fn(() => {
			throw stop;
		});
		prepareSubmitHandler(context);

		const runPromise = proto.run.call(context);
		await submit(context, "just text");
		await expect(runPromise).rejects.toBe(stop);

		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [promptText, promptOptions] = context.session.prompt.mock.calls[0] as [string, Record<string, unknown>];
		expect(promptText).toBe("just text");
		expect(promptOptions).toEqual(
			expect.objectContaining({
				streamingBehavior: "steer",
				preflightResult: expect.any(Function),
				promptDisposition: expect.any(Function),
			}),
		);
	});

	it("resolves markers into the widened getUserInput payload and clears pendingImages", async () => {
		const pending = image("QUJDRA==");
		const context = createModeContext();
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "look at [Image #1]");

		await expect(userInput).resolves.toEqual({
			text: "look at [Image #1]",
			images: [pending],
			pendingEchoId: "pending-test-1",
		});
		expect(context.pendingImages.size).toBe(0);
	});

	it("returns queued submissions (with images) from getUserInput before installing a callback", async () => {
		const queued = image("cXVldWVk");
		const context = createModeContext();
		context.pendingUserInputs.push({ text: "queued [Image #1]", images: [queued], pendingEchoId: "pending-test-1" });

		await expect(proto.getUserInput.call(context)).resolves.toEqual({
			text: "queued [Image #1]",
			images: [queued],
			pendingEchoId: "pending-test-1",
		});
		expect(context.onInputCallback).toBeUndefined();
	});

	it("submits two markers in reading order with final text [Image #1] then [Image #2]", async () => {
		const first = image("RklSU1Q=");
		const second = image("U0VDT05E");
		const context = createModeContext();
		context.pendingImages.set(1, first);
		context.pendingImages.set(2, second);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "shot [Image #1] then [Image #2]");

		const resolved = await userInput;
		expect(resolved.text).toBe("shot [Image #1] then [Image #2]");
		expect(resolved.images).toEqual([first, second]);
		expect(context.pendingImages.size).toBe(0);
	});

	it("numbers markers canonically so the Nth marker pairs with images[N-1] after an out-of-order paste", async () => {
		const [redData, blueData] = await Promise.all([processedData(PNG_RED_BASE64), processedData(PNG_BLUE_BASE64)]);
		const { context, editor } = createRealEditorContext();

		await pasteImage(context, PNG_RED_BASE64);
		editor.handleInput("\x01"); // Home: the next paste lands BEFORE the marker
		await pasteImage(context, PNG_BLUE_BASE64);

		// The visible numbers must be canonical 1..k in reading order, so the
		// marker the user sees first ([Image #1]) is images[0]. The pre-fix text
		// "[Image #2][Image #1]" shipped one image and mispaired the survivor.
		expect(editor.getText()).toBe("[Image #1][Image #2]");
		prepareSubmitHandler(context, { shareEditor: true });

		const userInput = beginUserInput(context);
		editor.handleInput("\r"); // the real Enter -> submitValue -> onSubmit path
		const resolved = await vi.waitFor(async () => await userInput);

		expect(resolved.text).toBe("[Image #1][Image #2]");
		expect(resolved.images).toEqual([
			{ type: "image", data: blueData, mimeType: "image/png" },
			{ type: "image", data: redData, mimeType: "image/png" },
		]);
		expect(context.pendingImages.size).toBe(0);
	});

	it("passes no images key when every marker was deleted before submit", async () => {
		const context = createModeContext();
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "all markers deleted");

		await expect(userInput).resolves.toEqual({ text: "all markers deleted", pendingEchoId: "pending-test-1" });
	});

	it("passes plain text through with no images key", async () => {
		const context = createModeContext();
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "hello without attachments");

		await expect(userInput).resolves.toEqual({
			text: "hello without attachments",
			pendingEchoId: "pending-test-1",
		});
	});

	it("lets a hand-typed [Image #1] with no pending entry pass through untouched", async () => {
		const context = createModeContext();
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "look at [Image #1]");

		await expect(userInput).resolves.toEqual({ text: "look at [Image #1]", pendingEchoId: "pending-test-1" });
	});

	it("lets a hand-typed marker with no pending entry consume no slot before a real one", async () => {
		const pasted = image("UEFTVEVE");
		const context = createModeContext();
		// Reachable state: the user pastes an image ([Image #1], payload-bearing)
		// and also hand-types a literal [Image #2] in front of it. The hand-typed
		// marker owns no attachment, so it passes through untouched and the real
		// marker still resolves to images[0].
		context.pendingImages.set(1, pasted);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "typed [Image #2] by hand then pasted [Image #1]");

		await expect(userInput).resolves.toEqual({
			text: "typed [Image #2] by hand then pasted [Image #1]",
			images: [pasted],
			pendingEchoId: "pending-test-1",
		});
	});

	it("attaches the image once when a marker is duplicated by kill/yank", async () => {
		const pending = image("RFVQTElDQVRF");
		const context = createModeContext();
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "dup [Image #1] and [Image #1] again");

		const resolved = await userInput;
		expect(resolved.text).toBe("dup [Image #1] and [Image #1] again");
		expect(resolved.images).toEqual([pending]);
	});
});

describe("InteractiveMode image submission - steer path", () => {
	it("carries images on the streaming/steer branch and resolves before setText clears the map", async () => {
		const pending = image("U1RFRVI=");
		const context = createModeContext();
		context.session.isStreaming = true;
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		await submit(context, "steer this [Image #1]");

		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [text, options] = context.session.prompt.mock.calls[0] as [
			string,
			{ streamingBehavior?: string; images?: ImageContent[] },
		];
		expect(text).toBe("steer this [Image #1]");
		expect(options?.streamingBehavior).toBe("steer");
		expect(options?.images).toEqual([pending]);
		expect(context.pendingImages.size).toBe(0);
	});
});

describe("InteractiveMode image submission - Alt+Enter followUp", () => {
	it("resolves images BEFORE setText on the streaming followUp branch", async () => {
		const pending = image("Rk9MTG9X");
		const context = createModeContext();
		context.session.isStreaming = true;
		context.pendingImages.set(1, pending);
		context.editor.getText.mockReturnValue("describe [Image #1]");
		prepareSubmitHandler(context);

		await proto.handleFollowUp.call(context);

		// The setText("") in this branch fires onImageMarkersChanged([]), which
		// destroys pendingImages - so these assertions only pass if resolution
		// happened before the clear.
		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [text, options] = context.session.prompt.mock.calls[0] as [
			string,
			{ streamingBehavior?: string; images?: ImageContent[] },
		];
		expect(text).toBe("describe [Image #1]");
		expect(options?.streamingBehavior).toBe("followUp");
		expect(options?.images).toEqual([pending]);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.pendingImages.size).toBe(0);
	});

	it("routes non-streaming followUp through preResolvedSubmissionImages into the widened channel", async () => {
		const pending = image("Rk9MTE5PTg==");
		const context = createModeContext();
		context.pendingImages.set(1, pending);
		context.editor.getText.mockReturnValue("describe [Image #1]");
		prepareSubmitHandler(context, { shareEditor: true });

		const userInput = beginUserInput(context);
		await proto.handleFollowUp.call(context);

		// onSubmit(text) stayed a string-only public API; the images traveled
		// through the pre-resolved field and out the normal channel.
		await expect(userInput).resolves.toEqual({
			text: "describe [Image #1]",
			images: [pending],
			pendingEchoId: "pending-test-1",
		});
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.pendingImages.size).toBe(0);
		expect(context.preResolvedSubmissionImages).toBeUndefined();
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("leaves no stale images on the next ordinary submission after Alt+Enter on a slash command", async () => {
		const stale = image("U1RBTEU=");
		const context = createModeContext();
		context.preResolvedSubmissionImages = [stale];
		prepareSubmitHandler(context);

		// The /model branch returns before the image-consuming branch; the
		// pre-resolved array must not survive it.
		await submit(context, "/model");
		expect(context.preResolvedSubmissionImages).toBeUndefined();

		const userInput = beginUserInput(context);
		await submit(context, "next ordinary message");
		await expect(userInput).resolves.toEqual({
			text: "next ordinary message",
			pendingEchoId: "pending-test-1",
		});
	});

	it("leaves no stale images on the next ordinary submission after Alt+Enter on a bash command", async () => {
		const stale = image("U1RBTEUy");
		const context = createModeContext();
		context.preResolvedSubmissionImages = [stale];
		prepareSubmitHandler(context);

		await submit(context, "!ls");
		expect(context.preResolvedSubmissionImages).toBeUndefined();

		const userInput = beginUserInput(context);
		await submit(context, "next ordinary message");
		await expect(userInput).resolves.toEqual({
			text: "next ordinary message",
			pendingEchoId: "pending-test-1",
		});
	});
});

describe("InteractiveMode image submission - compaction boundary", () => {
	it("drops a pasted attachment with a visible status while the session is compacting", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce({
			bytes: samplePngBytes(),
			mimeType: "image/png",
		});
		clipboardTextMock.readClipboardText.mockResolvedValueOnce(null);
		const context = createModeContext();
		context.session.isCompacting = true;

		await proto.handleClipboardPaste.call(context);

		// Pinned scope boundary: the compaction queue carries text only, so the
		// attachment is dropped here - visibly, never silently.
		expect(context.editor.insertImageMarker).not.toHaveBeenCalled();
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toMatch(/compact/i);
	});

	it("shows a visible drop status when Alt+Enter queues an image-bearing message during compaction", async () => {
		const pending = image("Rk9MTExXUVVFVUU=");
		const context = createModeContext();
		context.session.isCompacting = true;
		context.pendingImages.set(1, pending);
		context.editor.getText.mockReturnValue("look at [Image #1]");

		await proto.handleFollowUp.call(context);

		// The compaction queue carries text only: the attachment is dropped
		// VISIBLY (never a silent loss), its dead literal marker never ships in
		// the queued text, and pendingImages does not leak into a later turn.
		expect(context.compactionQueuedMessages).toHaveLength(1);
		expect(context.compactionQueuedMessages[0]?.text).toBe("look at");
		expect(context.compactionQueuedMessages[0]?.mode).toBe("followUp");
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		const status = String(context.showStatus.mock.calls[0]?.[0]);
		expect(status).toMatch(/compact/i);
		expect(status).toMatch(/image/i);
	});

	it("shows a visible drop status when Enter queues an image-bearing message during compaction", async () => {
		const pending = image("U1RFRVJRVUVVRR==");
		const context = createModeContext();
		context.session.isCompacting = true;
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		await submit(context, "look at [Image #1]");

		expect(context.compactionQueuedMessages).toHaveLength(1);
		expect(context.compactionQueuedMessages[0]?.text).toBe("look at");
		expect(context.compactionQueuedMessages[0]?.mode).toBe("steer");
		expect(context.pendingImages.size).toBe(0);
		const status = String(context.showStatus.mock.calls[0]?.[0]);
		expect(status).toMatch(/compact/i);
		expect(status).toMatch(/image/i);
	});
});
