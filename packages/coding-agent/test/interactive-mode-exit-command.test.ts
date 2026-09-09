import { describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

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
	onInputCallback?: (input: { text: string; images?: unknown[] }) => void;
	pendingUserInputs: { text: string; images?: unknown[] }[];
	pendingImages: Map<number, unknown>;
	optimisticUserEchoes: ReturnType<typeof createEchoControllerStub>;
	takeSubmissionImages: (submittedText: string) => unknown[];
	shutdown: () => Promise<void>;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	takeSubmissionImages(this: SubmitContext, submittedText: string): unknown[];
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
		shutdown: vi.fn(async () => {}),
	};
	// Borrowed receiver: resolve markers with the REAL production helper (its
	// only dependencies are the pendingImages map above).
	context.takeSubmissionImages = interactiveModePrototype.takeSubmissionImages.bind(context);
	return context;
}

describe("BUILTIN_SLASH_COMMANDS exit alias", () => {
	it("registers an 'exit' builtin next to 'quit'", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).toContain("exit");
		expect(names).toContain("quit");
	});

	it("describes 'exit' as an alias of /quit referencing the app name", () => {
		const exitCommand = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "exit");
		expect(exitCommand).toBeDefined();
		expect(exitCommand?.description).toContain(APP_NAME);
		expect(exitCommand?.description.toLowerCase()).toContain("alias");
		expect(exitCommand?.description).toContain("/quit");
	});
});

describe("InteractiveMode /exit routing", () => {
	it("routes /exit to shutdown like /quit and clears the editor", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/exit");

		expect(context.shutdown).toHaveBeenCalledTimes(1);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("still routes /quit to shutdown", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/quit");

		expect(context.shutdown).toHaveBeenCalledTimes(1);
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("does not treat /exit-suffixed text as the exit command", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/exit-status");

		expect(context.shutdown).not.toHaveBeenCalled();
	});
});
