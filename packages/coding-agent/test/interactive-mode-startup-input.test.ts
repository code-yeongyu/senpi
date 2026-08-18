import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

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
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type RunContext = {
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
	getUserInput: () => Promise<string>;
	showNewVersionNotification: (version: string) => void;
	showPackageUpdateNotification: (packages: string[]) => void;
	showRiskyMainModelWarning: () => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	run(this: RunContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
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
	};
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

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("preserves steer intent when the main loop drains queued input", async () => {
		// Given a queued prompt followed by a sentinel that stops the infinite loop.
		const stopMainLoop = new Error("stop interactive loop");
		const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
		const getUserInput = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("queued prompt")
			.mockRejectedValueOnce(stopMainLoop);
		const context: RunContext = {
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
		expect(prompt).toHaveBeenCalledWith("queued prompt", { streamingBehavior: "steer" });
	});
});
