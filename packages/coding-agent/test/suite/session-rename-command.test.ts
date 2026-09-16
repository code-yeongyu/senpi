import { beforeAll, describe, expect, it, vi } from "vitest";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import {
	createKeyHandlersContext,
	createRenameSubmitContext,
	interactiveModeInternals,
	renderedText,
} from "./session-rename-fixtures.ts";

vi.mock("../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

beforeAll(() => {
	initTheme("dark");
});

describe("builtin /rename slash command", () => {
	it("registers /rename with an optional name argument", () => {
		const rename = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "rename");

		expect(rename).toEqual({
			name: "rename",
			description: "Rename the current session",
			argumentHint: "[name]",
		});
	});

	it("keeps /name registered as the /rename alias", () => {
		const alias = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "name");

		expect(alias?.description).toBe("Alias of /rename (set session display name)");
	});
});

describe("app.session.renameCurrent keybinding", () => {
	it("ships unbound so it cannot steal a main-editor key", () => {
		expect(KEYBINDINGS["app.session.renameCurrent"]).toEqual({
			defaultKeys: [],
			description: "Rename the current session",
		});
	});

	it("opens the inline rename editor when the action fires", () => {
		const context = createKeyHandlersContext();
		interactiveModeInternals.setupKeyHandlers.call(context);

		void context.actions.get("app.session.renameCurrent")?.();

		expect(context.renameEditorOpens).toBe(1);
	});
});

describe("InteractiveMode rename command dispatch", () => {
	it("renames the session when /rename carries a name", async () => {
		const context = createRenameSubmitContext();
		interactiveModeInternals.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/rename Ship it");

		expect(context.session.renameCalls).toEqual(["Ship it"]);
		expect(context.editorTexts).toEqual([""]);
	});

	it("renames the session when the /name alias carries a name", async () => {
		const context = createRenameSubmitContext();
		interactiveModeInternals.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/name Ship it");

		expect(context.session.renameCalls).toEqual(["Ship it"]);
		expect(context.editorTexts).toEqual([""]);
	});

	it("prints the stored name in the transcript", async () => {
		const context = createRenameSubmitContext();
		interactiveModeInternals.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/rename Ship it");

		expect(renderedText(context.chatContainer)).toContain("Session name set: Ship it");
	});

	it("warns when the session normalizes the requested name", async () => {
		const context = createRenameSubmitContext();
		interactiveModeInternals.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/rename ship\nit");

		expect(context.warnings).toEqual(['Session name was normalized from "ship\\nit" to "ship it"']);
	});

	it("opens the inline rename editor for a bare /rename", async () => {
		const context = createRenameSubmitContext("Old Name");
		interactiveModeInternals.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/rename");

		expect(context.renameEditorOpens).toBe(1);
		expect(context.session.renameCalls).toEqual([]);
	});

	it("opens the inline rename editor for a bare /name", async () => {
		const context = createRenameSubmitContext("Old Name");
		interactiveModeInternals.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/name");

		expect(context.renameEditorOpens).toBe(1);
		expect(context.session.renameCalls).toEqual([]);
	});

	it("treats /renamed as ordinary input", async () => {
		const context = createRenameSubmitContext();
		interactiveModeInternals.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/renamed the session");

		expect(context.session.renameCalls).toEqual([]);
		expect(context.renameEditorOpens).toBe(0);
		expect(context.pendingUserInputs).toEqual([{ text: "/renamed the session", pendingEchoId: "pending-test" }]);
	});
});
