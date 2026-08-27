import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

type EchoControllerStub = ReturnType<typeof createEchoControllerStub>;

function createEchoControllerStub() {
	return {
		begin: vi.fn(() => "pending-test"),
		promptOptions: vi.fn(() => ({ preflightResult: vi.fn(), promptDisposition: vi.fn() })),
		reject: vi.fn(),
	};
}

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
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
	onInputCallback?: (input: { text: string; images?: unknown[]; pendingEchoId: string }) => void;
	pendingUserInputs: { text: string; images?: unknown[]; pendingEchoId: string }[];
	pendingImages: Map<number, unknown>;
	optimisticUserEchoes: EchoControllerStub;
	takeSubmissionImages: (submittedText: string) => unknown[];
};

type InputContext = {
	onInputCallback?: (input: { text: string; images?: unknown[]; pendingEchoId?: string }) => void;
	pendingUserInputs: { text: string; images?: unknown[]; pendingEchoId?: string }[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type RunContext = {
	optimisticUserEchoes: EchoControllerStub;
	init: () => Promise<void>;
	version: string;
	options: Record<string, never>;
	session: {
		modelRuntime: { getError: () => string | undefined; refresh: () => Promise<void> };
		fallbackValidationWarnings: readonly string[];
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	checkForPackageUpdates: () => Promise<string[]>;
	checkTmuxSetup: () => Promise<string | undefined>;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	getUserInput: () => Promise<{ text: string; images?: unknown[]; pendingEchoId: string }>;
	buildMainLoopPromptOptions: (userInput: { text: string; images?: unknown[]; pendingEchoId: string }) => {
		streamingBehavior: "steer";
		preflightResult: (s: boolean) => void;
		promptDisposition: (d: string) => void;
	};
	clearStatusIndicator: (kind?: string) => void;
	ui: { requestRender: () => void };
	agentIdle: boolean;
	showNewVersionNotification: (version: string) => void;
	showPackageUpdateNotification: (packages: string[]) => void;
	showRiskyMainModelWarning: () => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<{ text: string; images?: unknown[] }>;
	takeSubmissionImages(this: SubmitContext, submittedText: string): unknown[];
	buildMainLoopPromptOptions(
		this: RunContext,
		userInput: { text: string; images?: unknown[]; pendingEchoId: string },
	): { streamingBehavior: "steer"; preflightResult: (s: boolean) => void; promptDisposition: (d: string) => void };
	run(this: RunContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	const context: SubmitContext = {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
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
	};
	// Borrowed receiver: resolve markers with the REAL production helper (its
	// only dependencies are the pendingImages map above).
	context.takeSubmissionImages = interactiveModePrototype.takeSubmissionImages.bind(context);
	return context;
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt", pendingEchoId: "pending-test" }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({
			text: "queued prompt",
		});
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("preserves steer intent when the main loop drains queued input", async () => {
		// Given a queued prompt followed by a sentinel that stops the infinite loop.
		const stopMainLoop = new Error("stop interactive loop");
		const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
		const getUserInput = vi
			.fn<() => Promise<{ text: string; images?: unknown[]; pendingEchoId: string }>>()
			.mockResolvedValueOnce({ text: "queued prompt", pendingEchoId: "pending-test" })
			.mockRejectedValueOnce(stopMainLoop);
		const context: RunContext = {
			optimisticUserEchoes: createEchoControllerStub(),
			init: vi.fn(async () => {}),
			version: "test",
			options: {},
			session: {
				modelRuntime: { getError: vi.fn(() => undefined), refresh: vi.fn(async () => undefined) },
				fallbackValidationWarnings: [],
				prompt,
			},
			checkForPackageUpdates: vi.fn(async (): Promise<string[]> => []),
			checkTmuxSetup: vi.fn(async () => undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
			getUserInput,
			buildMainLoopPromptOptions: (userInput: { text: string; images?: unknown[]; pendingEchoId: string }) =>
				interactiveModePrototype.buildMainLoopPromptOptions.call(context, userInput),
			clearStatusIndicator: vi.fn(),
			ui: { requestRender: vi.fn() },
			agentIdle: false,
			showNewVersionNotification: vi.fn(),
			showPackageUpdateNotification: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		// When the real run loop drains that prompt.
		await expect(interactiveModePrototype.run.call(context)).rejects.toBe(stopMainLoop);

		// Then dispatch retains steer intent in case a continuation became active.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith(
			"queued prompt",
			expect.objectContaining({
				streamingBehavior: "steer",
				preflightResult: expect.any(Function),
				promptDisposition: expect.any(Function),
			}),
		);
	});
});
