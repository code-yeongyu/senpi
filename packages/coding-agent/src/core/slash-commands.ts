import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	requiresArguments?: boolean;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{
		name: "model",
		description: "Select model (opens selector UI)",
		argumentHint: "<provider/model>",
		requiresArguments: false,
	},
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>", requiresArguments: false },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "favorite-models", description: "Manage favorite models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{
		name: "import",
		description: "Import and resume a session from a JSONL file",
		argumentHint: "<path.jsonl>",
		requiresArguments: true,
	},
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "rename", description: "Rename the current session", argumentHint: "[name]", requiresArguments: false },
	{ name: "name", description: "Alias of /rename (set session display name)" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{
		name: "login",
		description: "Configure provider authentication",
		argumentHint: "<provider>",
		requiresArguments: false,
	},
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "sessions", description: "Alias of /resume (browse and resume past sessions)" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
	{ name: "exit", description: `Quit ${APP_NAME} (alias of /quit)` },
];
