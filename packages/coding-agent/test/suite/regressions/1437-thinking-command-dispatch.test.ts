import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

vi.mock("../../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

// Issue #1437: `/thinking` sat in BUILTIN_SLASH_COMMANDS (autocomplete, /help) but
// the interactive submit handler had no branch for it, so the text fell through
// to session.prompt() and reached the model as an ordinary user message.

function createEchoControllerStub() {
	return {
		begin: vi.fn(() => "pending-test"),
		promptOptions: vi.fn(() => ({ preflightResult: vi.fn(), promptDisposition: vi.fn() })),
		reject: vi.fn(),
	};
}

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: { addToHistory?: (text: string) => void; setText: (text: string) => void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	hideShortcutOverlay: () => void;
	isExtensionCommand: (text: string) => boolean;
	lastEditorText: string;
	onInputCallback?: (input: { text: string; images?: unknown[] }) => void;
	pendingUserInputs: { text: string; images?: unknown[] }[];
	pendingImages: Map<number, unknown>;
	optimisticUserEchoes: ReturnType<typeof createEchoControllerStub>;
	takeSubmissionImages: (submittedText: string) => unknown[];
	handleThinkingCommand: (searchTerm?: string) => Promise<void>;
};

type ThinkingContext = {
	session: {
		thinkingLevel: string;
		getAvailableThinkingLevels: () => string[] | Promise<string[]>;
		setThinkingLevel: (level: string) => void;
		setSessionThinkingLevel: (level: string) => void;
	};
	footer: { invalidate: () => void };
	updateEditorBorderColor: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	showThinkingSelector: () => Promise<void>;
	selectThinkingLevel: (level: string, persist: boolean) => void;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	takeSubmissionImages(this: SubmitContext, submittedText: string): unknown[];
	handleThinkingCommand(this: ThinkingContext, searchTerm?: string): Promise<void>;
	selectThinkingLevel(this: ThinkingContext, level: string, persist: boolean): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	const context: SubmitContext = {
		defaultEditor: {},
		editor: { addToHistory: vi.fn(), setText: vi.fn() },
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		hideShortcutOverlay: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		lastEditorText: "",
		pendingUserInputs: [],
		pendingImages: new Map(),
		optimisticUserEchoes: createEchoControllerStub(),
		takeSubmissionImages: vi.fn(() => []),
		handleThinkingCommand: vi.fn(async () => {}),
	};
	context.takeSubmissionImages = prototype.takeSubmissionImages.bind(context);
	return context;
}

function createThinkingContext(levels: string[] | Promise<string[]>): ThinkingContext {
	const context: ThinkingContext = {
		session: {
			thinkingLevel: "medium",
			getAvailableThinkingLevels: vi.fn(() => levels),
			setThinkingLevel: vi.fn(),
			setSessionThinkingLevel: vi.fn(),
		},
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showThinkingSelector: vi.fn(async () => {}),
		selectThinkingLevel: vi.fn(),
	};
	context.selectThinkingLevel = prototype.selectThinkingLevel.bind(context);
	return context;
}

describe("#1437 /thinking is dispatched by the interactive submit handler", () => {
	it("routes /thinking <level> to the handler instead of the model", async () => {
		//#given
		const context = createSubmitContext();
		prototype.setupEditorSubmitHandler.call(context);

		//#when
		await context.defaultEditor.onSubmit?.("/thinking high");

		//#then
		expect(context.handleThinkingCommand).toHaveBeenCalledWith("high");
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("routes bare /thinking to the selector path", async () => {
		//#given
		const context = createSubmitContext();
		prototype.setupEditorSubmitHandler.call(context);

		//#when
		await context.defaultEditor.onSubmit?.("/thinking");

		//#then
		expect(context.handleThinkingCommand).toHaveBeenCalledWith(undefined);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("does not treat /thinking-prefixed text as the command", async () => {
		//#given
		const context = createSubmitContext();
		prototype.setupEditorSubmitHandler.call(context);

		//#when
		await context.defaultEditor.onSubmit?.("/thinking-out-loud");

		//#then
		expect(context.handleThinkingCommand).not.toHaveBeenCalled();
	});
});

describe("#1437 handleThinkingCommand", () => {
	it("applies a known level to the session only, without touching the remembered default", async () => {
		//#given
		const context = createThinkingContext(["off", "low", "high"]);

		//#when
		await prototype.handleThinkingCommand.call(context, "high");

		//#then
		expect(context.session.setSessionThinkingLevel).toHaveBeenCalledWith("high");
		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Thinking level: high");
		expect(context.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(context.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("matches the level case-insensitively and awaits a shared-host level list", async () => {
		//#given - the shared-host proxy answers getAvailableThinkingLevels over RPC
		const context = createThinkingContext(Promise.resolve(["off", "low", "high"]));

		//#when
		await prototype.handleThinkingCommand.call(context, "HIGH");

		//#then
		expect(context.session.setSessionThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("rejects an unknown level and lists the available ones", async () => {
		//#given
		const context = createThinkingContext(["off", "low", "high"]);

		//#when
		await prototype.handleThinkingCommand.call(context, "turbo");

		//#then
		expect(context.showError).toHaveBeenCalledWith(
			'Unknown thinking level "turbo". Available levels: off, low, high.',
		);
		expect(context.session.setSessionThinkingLevel).not.toHaveBeenCalled();
		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("opens the selector when no level is given", async () => {
		//#given
		const context = createThinkingContext(["off", "low", "high"]);

		//#when
		await prototype.handleThinkingCommand.call(context, undefined);

		//#then
		expect(context.showThinkingSelector).toHaveBeenCalledTimes(1);
		expect(context.session.setSessionThinkingLevel).not.toHaveBeenCalled();
	});

	it("persists through setThinkingLevel only on the explicit default path", () => {
		//#given
		const context = createThinkingContext(["off", "low", "high"]);

		//#when
		context.selectThinkingLevel("low", true);

		//#then
		expect(context.session.setThinkingLevel).toHaveBeenCalledWith("low");
		expect(context.session.setSessionThinkingLevel).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Default thinking level: low");
	});
});
