import type { EditorSubmitDetails } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { UnknownCommandError } from "../../../src/core/unknown-command.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

vi.mock("../../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

// omo #9042 B: the TUI turns an unknown-command rejection into editor feedback instead of an error,
// and a leading space sends `/...` text through unchecked.

type Submission = { text: string; unknownCommandAsText?: boolean };

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string, details?: EditorSubmitDetails) => void | Promise<void> };
	editor: { text: string; getText(): string; setText(text: string): void; addToHistory(text: string): void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		messages: unknown[];
		prompt: ReturnType<typeof vi.fn>;
	};
	ui: { requestRender(): void };
	showWarning: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	flushPendingBashComponents(): void;
	hideShortcutOverlay(): void;
	updatePendingMessagesDisplay(): void;
	isExtensionCommand(text: string): boolean;
	submitAsyncQuestionComment(text: string): boolean;
	lastEditorText: string;
	pendingUserInputs: Submission[];
	takeSubmissionImages(text: string): unknown[];
	beginUserEcho(text: string): string | undefined;
	optimisticUserEchoes: { promptOptions(): object; reject: ReturnType<typeof vi.fn> };
	refusedUnknownCommandText?: string | undefined;
	reportUnknownCommandRejection?: (error: unknown, text: string) => boolean;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	reportUnknownCommandRejection(this: SubmitContext, error: unknown, text: string): boolean;
	buildMainLoopPromptOptions(this: SubmitContext, input: Submission & { pendingEchoId: undefined }): object;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createContext(options: { streaming: boolean; prompt?: () => Promise<void> }): SubmitContext {
	const context: SubmitContext = {
		defaultEditor: {},
		editor: {
			text: "",
			getText() {
				return this.text;
			},
			setText(text) {
				this.text = text;
			},
			addToHistory: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: options.streaming,
			isBashRunning: false,
			messages: [],
			prompt: vi.fn(options.prompt ?? (async () => {})),
		},
		ui: { requestRender: vi.fn() },
		showWarning: vi.fn(),
		showError: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		hideShortcutOverlay: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		isExtensionCommand: () => false,
		submitAsyncQuestionComment: () => false,
		lastEditorText: "",
		pendingUserInputs: [],
		takeSubmissionImages: () => [],
		beginUserEcho: () => "echo-1",
		optimisticUserEchoes: { promptOptions: () => ({}), reject: vi.fn() },
	};
	context.reportUnknownCommandRejection = (error, text) =>
		prototype.reportUnknownCommandRejection.call(context, error, text);
	prototype.setupEditorSubmitHandler.call(context);
	return context;
}

const rejection = new UnknownCommandError("ulw-exec", ["skill:ulw-execute"], "unknown");

describe("unknown command feedback in the interactive editor", () => {
	it("drops the echo, restores the text, and warns when a steering prompt is rejected", async () => {
		const context = createContext({ streaming: true, prompt: async () => Promise.reject(rejection) });

		await context.defaultEditor.onSubmit?.("/ulw-exec plan", { rawText: "/ulw-exec plan" });

		expect(context.optimisticUserEchoes.reject).toHaveBeenCalledWith("echo-1");
		expect(context.editor.text).toBe("/ulw-exec plan");
		expect(context.showWarning).toHaveBeenCalledWith(
			expect.stringMatching(/^Unknown command \/ulw-exec\. Did you mean \/skill:ulw-execute\?\n/),
		);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("keeps a draft typed after the submission instead of overwriting it", () => {
		const context = createContext({ streaming: false });
		context.editor.setText("new draft");

		const handled = prototype.reportUnknownCommandRejection.call(context, rejection, "/ulw-exec plan");

		expect(handled).toBe(true);
		expect(context.editor.text).toBe("new draft");
		expect(context.showWarning).toHaveBeenCalledWith(expect.stringContaining(rejection.message));
	});

	it("reports other errors as unhandled", () => {
		const context = createContext({ streaming: false });

		expect(prototype.reportUnknownCommandRejection.call(context, new Error("boom"), "hi")).toBe(false);
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it("sends a leading-space steering submission with the unknown-command check off", async () => {
		const context = createContext({ streaming: true });

		await context.defaultEditor.onSubmit?.("/foo bar", { rawText: " /foo bar" });

		expect(context.session.prompt).toHaveBeenCalledWith(
			"/foo bar",
			expect.objectContaining({ unknownCommandAsText: true }),
		);
	});

	it("carries the leading-space escape through an idle submission into the prompt options", async () => {
		const context = createContext({ streaming: false });

		await context.defaultEditor.onSubmit?.("/foo bar", { rawText: " /foo bar" });
		await context.defaultEditor.onSubmit?.("/foo bar", { rawText: "/foo bar" });

		const [escaped, checked] = context.pendingUserInputs;
		expect(escaped?.unknownCommandAsText).toBe(true);
		expect(checked?.unknownCommandAsText).toBeUndefined();
		expect(
			prototype.buildMainLoopPromptOptions.call(context, {
				text: "/foo bar",
				pendingEchoId: undefined,
				unknownCommandAsText: true,
			}),
		).toEqual(expect.objectContaining({ unknownCommandAsText: true }));
	});

	it("sends the refused text as a message when the same text is submitted again", async () => {
		const context = createContext({ streaming: false });
		prototype.reportUnknownCommandRejection.call(context, rejection, "/ulw-exec plan");

		await context.defaultEditor.onSubmit?.("/ulw-exec plan", { rawText: "/ulw-exec plan" });

		expect(context.pendingUserInputs[0]?.unknownCommandAsText).toBe(true);
	});

	it("confirms a refused steering prompt with a second submission of the same text", async () => {
		let rejectNext = true;
		const context = createContext({
			streaming: true,
			prompt: async () => {
				if (!rejectNext) return;
				rejectNext = false;
				throw rejection;
			},
		});

		await context.defaultEditor.onSubmit?.("/ulw-exec plan", { rawText: "/ulw-exec plan" });
		await context.defaultEditor.onSubmit?.("/ulw-exec plan", { rawText: "/ulw-exec plan" });

		expect(context.session.prompt).toHaveBeenLastCalledWith(
			"/ulw-exec plan",
			expect.objectContaining({ unknownCommandAsText: true }),
		);
	});

	it("checks the command again after the text changes or the confirmation is cancelled", async () => {
		const context = createContext({ streaming: false });
		prototype.reportUnknownCommandRejection.call(context, rejection, "/ulw-exec plan");
		await context.defaultEditor.onSubmit?.("/ulw-exec plans", { rawText: "/ulw-exec plans" });
		await context.defaultEditor.onSubmit?.("/ulw-exec plan", { rawText: "/ulw-exec plan" });

		prototype.reportUnknownCommandRejection.call(context, rejection, "/ulw-exec plan");
		context.refusedUnknownCommandText = undefined;
		await context.defaultEditor.onSubmit?.("/ulw-exec plan", { rawText: "/ulw-exec plan" });

		expect(context.pendingUserInputs.map((input) => input.unknownCommandAsText)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});
});
