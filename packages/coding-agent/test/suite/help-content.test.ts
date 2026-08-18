import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KEYBINDINGS, type Keybinding, KeybindingsManager } from "../../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo } from "../../src/core/slash-commands.ts";
import { keyDisplayText } from "../../src/modes/interactive/components/keybinding-hints.ts";
import { buildHelpMarkdown } from "../../src/modes/interactive/help-content.ts";

const extensionCommand: SlashCommandInfo = {
	name: "inspect-extension",
	description: "Inspect extension state",
	source: "extension",
	sourceInfo: {
		path: "/tmp/inspect-extension.ts",
		source: "test",
		scope: "temporary",
		origin: "top-level",
	},
};

function section(markdown: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = markdown.indexOf(marker);
	if (start < 0) return "";
	const content = markdown.slice(start + marker.length);
	const nextSection = content.indexOf("\n## ");
	return nextSection < 0 ? content : content.slice(0, nextSection);
}

function commandNames(markdown: string): Set<string> {
	const names = new Set<string>();
	for (const line of section(markdown, "Commands").split("\n")) {
		const match = /^\/([^ ]+) — /.exec(line);
		if (match?.[1]) names.add(match[1]);
	}
	return names;
}

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("buildHelpMarkdown", () => {
	it("includes the getting-started primer and all section headers", () => {
		const markdown = buildHelpMarkdown({ extensionCommands: [] });
		const gettingStarted = section(markdown, "Getting started");

		expect(markdown).toContain("## Getting started");
		expect(markdown).toContain("## Keybindings");
		expect(markdown).toContain("## Commands");
		expect(gettingStarted).toContain(keyDisplayText("tui.input.submit"));
		expect(gettingStarted).toContain(keyDisplayText("tui.input.newLine"));
		expect(gettingStarted).toContain(keyDisplayText("app.clipboard.pasteImage"));
		expect(gettingStarted).toContain(keyDisplayText("app.message.followUp"));
		for (const usage of ["`!`", "`!!`", "`/`", "drop files", "`?`"]) {
			expect(gettingStarted.toLowerCase()).toContain(usage);
		}
	});

	it("renders every live keybinding in prefix-grouped tables, including selection bindings", () => {
		const markdown = buildHelpMarkdown({ extensionCommands: [] });
		const keybindings = section(markdown, "Keybindings");
		const rows = new Set(keybindings.split("\n"));

		for (const id of Object.keys(KEYBINDINGS) as Keybinding[]) {
			const keys = keyDisplayText(id);
			if (!keys) continue;
			expect(rows.has(`| \`${keys}\` | ${KEYBINDINGS[id].description} |`), id).toBe(true);
		}
		expect(keybindings).toContain("### Selection");
		const selectionId = "tui.select.confirm";
		expect(rows.has(`| \`${keyDisplayText(selectionId)}\` | ${KEYBINDINGS[selectionId].description} |`)).toBe(true);
	});

	it("merges builtins with extension commands and deduplicates by command name", () => {
		const duplicateBuiltin: SlashCommandInfo = {
			...extensionCommand,
			name: "model",
			description: "Extension model override",
		};
		const markdown = buildHelpMarkdown({ extensionCommands: [extensionCommand, duplicateBuiltin] });
		const commands = section(markdown, "Commands");
		const names = commandNames(markdown);

		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(names.has(command.name), command.name).toBe(true);
		}
		expect(commands).toContain("/inspect-extension — Inspect extension state");
		expect(commands).not.toContain("Extension model override");
		expect(commands.split("\n").filter((line) => line.startsWith("/model —"))).toHaveLength(1);
	});

	it("uses live remapped keys in keybinding rows and builtin command descriptions", () => {
		setKeybindings(
			new KeybindingsManager({
				"app.thinking.cycle": "ctrl+1",
				"app.model.cycleForward": "ctrl+9",
			}),
		);

		const remappedThinkingKey = keyDisplayText("app.thinking.cycle");
		const remappedModelKey = keyDisplayText("app.model.cycleForward");
		const markdown = buildHelpMarkdown({ extensionCommands: [] });
		const keybindings = section(markdown, "Keybindings");
		const commands = section(markdown, "Commands");

		expect(keybindings).toContain(`| \`${remappedThinkingKey}\` | Cycle thinking level |`);
		expect(keybindings.toLowerCase()).not.toContain("shift+tab");
		expect(commands).toContain(`/favorite-models — Manage favorite models for ${remappedModelKey} cycling`);
		const favoriteModelsLine = commands.split("\n").find((line) => line.includes("/favorite-models"));
		expect(favoriteModelsLine).toBeDefined();
		expect(favoriteModelsLine).not.toContain("Ctrl+P");
	});

	it("lists every builtin when no extension commands are provided", () => {
		const markdown = buildHelpMarkdown({ extensionCommands: [] });
		const names = commandNames(markdown);

		expect(names.size).toBeGreaterThan(0);
		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(names.has(command.name), command.name).toBe(true);
		}
	});
});
