import { KEYBINDINGS, type Keybinding } from "../../core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo } from "../../core/slash-commands.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";

const KEYBINDING_GROUPS = [
	{ prefix: "tui.editor.", heading: "Editor" },
	{ prefix: "tui.input.", heading: "Input" },
	{ prefix: "tui.select.", heading: "Selection" },
	{ prefix: "tui.altScreen.", heading: "Alt Screen" },
	{ prefix: "app.", heading: "Application" },
] as const;

function escapeTableCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function buildGettingStarted(): string {
	const submit = keyDisplayText("tui.input.submit");
	const newLine = keyDisplayText("tui.input.newLine");
	const pasteImage = keyDisplayText("app.clipboard.pasteImage");
	const followUp = keyDisplayText("app.message.followUp");

	return [
		`- Press \`${submit}\` to submit; use \`${newLine}\` to add a new line.`,
		"- Type `!` to run bash, or `!!` to run bash without adding the command or output to context.",
		"- Type `/` for commands.",
		"- Drop files into the terminal to attach them.",
		`- Press \`${pasteImage}\` to paste an image, with text fallback.`,
		`- Press \`${followUp}\` to queue a follow-up message.`,
		"- Press `?` on an empty input to show the shortcut overlay.",
	].join("\n");
}

function buildKeybindingTables(): string {
	const rowsByPrefix = new Map(KEYBINDING_GROUPS.map((group) => [group.prefix, [] as string[]]));

	for (const [id, definition] of Object.entries(KEYBINDINGS)) {
		const group = KEYBINDING_GROUPS.find((candidate) => id.startsWith(candidate.prefix));
		if (!group) throw new Error(`Unsupported keybinding group: ${id}`);

		const keys = keyDisplayText(id as Keybinding);
		if (!keys) continue;

		const rows = rowsByPrefix.get(group.prefix);
		if (!rows) throw new Error(`Missing keybinding group: ${group.prefix}`);
		rows.push(`| \`${escapeTableCell(keys)}\` | ${escapeTableCell(definition.description)} |`);
	}

	return KEYBINDING_GROUPS.map((group) => {
		const rows = rowsByPrefix.get(group.prefix) ?? [];
		return [`### ${group.heading}`, "| Key | Action |", "|-----|--------|", ...rows].join("\n");
	}).join("\n\n");
}

export function buildHelpMarkdown(input: { extensionCommands: SlashCommandInfo[] }): string {
	const commandDescriptionOverrides = new Map<string, string>([
		["favorite-models", `Manage favorite models for ${keyDisplayText("app.model.cycleForward")} cycling`],
	]);
	const commandsByName = new Map<string, { name: string; description?: string }>();

	for (const command of [...BUILTIN_SLASH_COMMANDS, ...input.extensionCommands]) {
		if (!commandsByName.has(command.name)) commandsByName.set(command.name, command);
	}

	const commandLines = [...commandsByName.values()].map((command) => {
		const description = commandDescriptionOverrides.get(command.name) ?? command.description ?? "";
		return `/${command.name} — ${description}`;
	});

	return [
		"## Getting started",
		buildGettingStarted(),
		"## Keybindings",
		buildKeybindingTables(),
		"## Commands",
		commandLines.join("\n"),
		"## Account display names",
		"Use `/gpt-account rename <id> <display name...>`, `/claude-account rename <id> <display name...>`, or `/account <provider> rename <id> <display name...>`. Use `clear-name <id>` on the same command to remove the label.",
		"Labels display as `displayName (id)`; pins, removal, refresh and session affinity always use the unchanged ID. Labels are Unicode-normalized (NFC) with internal whitespace collapsed, limited to 32 terminal columns, must contain at least one visible character, and cannot contain control or formatting characters. Two labels that render identically cannot coexist in one provider: comparison folds case, compatibility forms, invisible code points, and Cyrillic lookalikes. Environment accounts cannot be renamed.",
		"`/gpt-account add` offers an optional display name after saving the account, when Senpi generated the account ID itself. The Claude lane asks for the account name through its own login prompt, so it never asks twice. Leave it blank or cancel to keep the successful login without a label. Legacy accounts display only their ID.",
	].join("\n\n");
}
