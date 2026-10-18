import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

vi.mock("../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

// Autocomplete and /help list BUILTIN_SLASH_COMMANDS, so every entry needs a branch in the
// interactive submit handler. An entry without one falls through to session.prompt() and
// reaches the model as a user message, which is how /thinking broke (#1437).

type SubmitHandlerOwner = { setupEditorSubmitHandler(this: object): void };

type SubmitHarness = {
	onSubmit: (text: string) => Promise<void>;
	prompt: ReturnType<typeof vi.fn>;
	onInputCallback: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	showSessionSelector: ReturnType<typeof vi.fn>;
};

function stubbed<T extends object>(known: T): T {
	const created = new Map<PropertyKey, unknown>();
	return new Proxy(known, {
		get(target, property, receiver) {
			if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
			if (!created.has(property))
				created.set(
					property,
					vi.fn(async () => undefined),
				);
			return created.get(property);
		},
	});
}

function createSubmitHarness(): SubmitHarness {
	const prompt = vi.fn(async () => {});
	const onInputCallback = vi.fn();
	const showError = vi.fn();
	const showSessionSelector = vi.fn();
	const known: { defaultEditor: { onSubmit?: (text: string) => Promise<void> } } & Record<string, unknown> = {
		defaultEditor: {},
		editor: stubbed({}),
		session: stubbed({ isStreaming: false, isCompacting: false, isBashRunning: false, prompt }),
		isExtensionCommand: vi.fn(() => false),
		submitAsyncQuestionComment: vi.fn(() => false),
		lastEditorText: "",
		pendingUserInputs: [],
		pendingImages: new Map(),
		onInputCallback,
		showError,
		showSessionSelector,
		sessionControlHost: undefined,
	};
	const context = stubbed(known);
	(InteractiveMode.prototype as unknown as SubmitHandlerOwner).setupEditorSubmitHandler.call(context);
	const onSubmit = known.defaultEditor.onSubmit;
	if (!onSubmit) throw new Error("setupEditorSubmitHandler did not install onSubmit");
	return { onSubmit, prompt, onInputCallback, showError, showSessionSelector };
}

describe("builtin slash command dispatch", () => {
	it.each(BUILTIN_SLASH_COMMANDS.map((command) => command.name))(
		"dispatches /%s without prompting the model",
		async (name) => {
			//#given
			const harness = createSubmitHarness();

			//#when
			await harness.onSubmit(`/${name}`);

			//#then
			expect(harness.prompt).not.toHaveBeenCalled();
			expect(harness.onInputCallback).not.toHaveBeenCalled();
			expect(harness.showError).not.toHaveBeenCalled();
		},
	);

	it("still sends ordinary text to the model", async () => {
		//#given
		const harness = createSubmitHarness();

		//#when
		await harness.onSubmit("hello");

		//#then
		expect(harness.onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
	});

	it("opens the same session picker for /sessions as for /resume", async () => {
		//#given
		const resume = createSubmitHarness();
		const sessions = createSubmitHarness();

		//#when
		await resume.onSubmit("/resume");
		await sessions.onSubmit("/sessions");

		//#then
		expect(resume.showSessionSelector).toHaveBeenCalledTimes(1);
		expect(sessions.showSessionSelector).toHaveBeenCalledTimes(1);
	});

	it("lists /sessions as the /resume alias", () => {
		const alias = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "sessions");
		expect(alias?.description).toBe("Alias of /resume (browse and resume past sessions)");
	});
});
