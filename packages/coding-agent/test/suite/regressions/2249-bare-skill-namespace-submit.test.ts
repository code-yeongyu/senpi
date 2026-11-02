import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

vi.mock("../../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: { addToHistory: (text: string) => void; setText: (text: string) => void; openAutocomplete: () => void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		messages: unknown[];
		prompt: (text: string, options?: unknown) => Promise<void>;
		resourceLoader: { getSkills: () => { skills: { name: string }[] } };
	};
	settingsManager: { getEnableSkillCommands: () => boolean };
	showWarning: (message: string) => void;
	flushPendingBashComponents: () => void;
	hideShortcutOverlay: () => void;
	isExtensionCommand: (text: string) => boolean;
	openSkillPickerForBareNamespace: () => void;
	lastEditorText: string;
	pendingUserInputs: unknown[];
	pendingImages: Map<number, unknown>;
	takeSubmissionImages: (submittedText: string) => unknown[];
	beginUserEcho: (text: string) => string | undefined;
	optimisticUserEchoes: { begin: () => string; promptOptions: () => object; reject: () => void };
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	openSkillPickerForBareNamespace(this: SubmitContext): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createContext(options: { skills?: string[]; enableSkillCommands?: boolean } = {}): SubmitContext {
	const skills = (options.skills ?? ["debugging", "ulw-plan"]).map((name) => ({ name }));
	const context: SubmitContext = {
		defaultEditor: {},
		editor: { addToHistory: vi.fn(), setText: vi.fn(), openAutocomplete: vi.fn() },
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			messages: [],
			prompt: vi.fn(async () => {}),
			resourceLoader: { getSkills: () => ({ skills }) },
		},
		settingsManager: { getEnableSkillCommands: () => options.enableSkillCommands ?? true },
		showWarning: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		hideShortcutOverlay: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		openSkillPickerForBareNamespace: () => {},
		lastEditorText: "",
		pendingUserInputs: [],
		pendingImages: new Map(),
		takeSubmissionImages: vi.fn(() => []),
		beginUserEcho: vi.fn(() => undefined),
		optimisticUserEchoes: { begin: vi.fn(() => "echo"), promptOptions: vi.fn(() => ({})), reject: vi.fn() },
	};
	context.openSkillPickerForBareNamespace = prototype.openSkillPickerForBareNamespace.bind(context);
	return context;
}

describe("#2249 a bare /skill namespace submission never reaches the model", () => {
	for (const text of ["/skill", "/skill:"]) {
		it(`reopens the skill picker for ${text}`, async () => {
			const context = createContext();
			prototype.setupEditorSubmitHandler.call(context);

			await context.defaultEditor.onSubmit?.(text);

			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.pendingUserInputs).toEqual([]);
			expect(context.editor.setText).toHaveBeenLastCalledWith("/skill:");
			expect(context.editor.openAutocomplete).toHaveBeenCalledTimes(1);
			expect(context.showWarning).not.toHaveBeenCalled();
		});
	}

	it("warns instead of opening an empty picker when no skill is loaded", async () => {
		const context = createContext({ skills: [] });
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/skill:");

		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith("No skills are loaded.");
		expect(context.editor.openAutocomplete).not.toHaveBeenCalled();
	});

	it("warns when skill commands are disabled", async () => {
		const context = createContext({ enableSkillCommands: false });
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/skill");

		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledTimes(1);
		expect(context.editor.openAutocomplete).not.toHaveBeenCalled();
	});

	it("leaves a real skill command and namespace-prefixed prose on the prompt path", async () => {
		const context = createContext();
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/skill:debugging why does it crash");
		await context.defaultEditor.onSubmit?.("/skills are great");

		expect(context.pendingUserInputs).toEqual([
			expect.objectContaining({ text: "/skill:debugging why does it crash" }),
			expect.objectContaining({ text: "/skills are great" }),
		]);
		expect(context.editor.openAutocomplete).not.toHaveBeenCalled();
	});
});
