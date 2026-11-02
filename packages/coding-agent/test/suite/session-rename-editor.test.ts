import { beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { activeInput, createRenameEditorHost, renderedText } from "./session-rename-fixtures.ts";

vi.mock("../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

const ESC = "\x1b";
const ENTER = "\n";

beforeAll(() => {
	initTheme("dark");
});

describe("inline session rename editor", () => {
	it("replaces the composer with a focused rename input", () => {
		const host = createRenameEditorHost("Old Name");

		host.showSessionRenameInput();

		expect(host.editorContainer.children).toHaveLength(1);
		expect(host.ui.focused).toBe(host.editorContainer.children[0]);
	});

	it("shows the rename title", () => {
		const host = createRenameEditorHost("Old Name");

		host.showSessionRenameInput();

		expect(renderedText(host.editorContainer)).toContain("Rename session");
	});

	it("prefills the current name with the cursor at its end", () => {
		const host = createRenameEditorHost("Old Name");
		host.showSessionRenameInput();
		const input = activeInput(host);

		input.handleInput("!");
		input.handleInput(ENTER);

		expect(host.session.renameCalls).toEqual(["Old Name!"]);
	});

	it("starts empty for a session that has no name yet", () => {
		const host = createRenameEditorHost();
		host.showSessionRenameInput();
		const input = activeInput(host);

		input.handleInput("Fresh");
		input.handleInput(ENTER);

		expect(host.session.renameCalls).toEqual(["Fresh"]);
	});

	it("restores and focuses the composer after committing", () => {
		const host = createRenameEditorHost("Old Name");
		host.showSessionRenameInput();
		const input = activeInput(host);

		input.handleInput(ENTER);

		expect(host.editorContainer.children).toEqual([host.editor]);
		expect(host.ui.focused).toBe(host.editor);
	});

	it("cancels without renaming when escape is pressed", () => {
		const host = createRenameEditorHost("Old Name");
		host.showSessionRenameInput();
		const input = activeInput(host);

		input.handleInput(ESC);

		expect(host.session.renameCalls).toEqual([]);
		expect(host.editorContainer.children).toEqual([host.editor]);
	});
});

describe("session rename commit", () => {
	it("warns and keeps the name when the commit is blank", async () => {
		const host = createRenameEditorHost("Old Name");

		await host.commitSessionRename("   ");

		expect(host.warnings).toEqual(["Session name cannot be empty"]);
		expect(host.session.renameCalls).toEqual([]);
	});

	it("does nothing when the commit matches the current name", async () => {
		const host = createRenameEditorHost("Old Name");

		await host.commitSessionRename("Old Name");

		expect(host.session.renameCalls).toEqual([]);
		expect(host.chatContainer.children).toEqual([]);
	});

	it("renames and reports the new name", async () => {
		const host = createRenameEditorHost("Old Name");

		await host.commitSessionRename("New Name");

		expect(host.session.renameCalls).toEqual(["New Name"]);
		expect(renderedText(host.chatContainer)).toContain("Session name set: New Name");
	});
});
