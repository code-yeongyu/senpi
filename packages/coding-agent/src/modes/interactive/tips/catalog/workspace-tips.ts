import { APP_NAME, agentDirLabel } from "../../../../config.ts";
import type { TipDefinition } from "./types.ts";

export const WORKSPACE_TIPS = [
	{
		id: "help-command",
		bindings: [],
		requiresCommand: "help",
		render: () => "Use /help to see available commands and guidance.",
	},
	{
		id: "keybindings-command",
		bindings: [],
		render: () => "Use /keybindings to review and customize keyboard shortcuts.",
	},
	{
		id: "agents-md-context",
		bindings: [],
		render: () =>
			`${APP_NAME} loads AGENTS.md from your home directory, every parent folder, and the current folder as project instructions.`,
	},
	{
		id: "skills-and-prompts",
		bindings: [],
		render: () =>
			`Skills run as /skill:name, and prompt templates in ${agentDirLabel()}/prompts expand as /templatename.`,
	},
	{
		id: "files-command",
		bindings: [],
		requiresCommand: "files",
		render: () => "Use /files to list every file this session read, wrote, or edited.",
	},
	{
		id: "diff-command",
		bindings: [],
		requiresCommand: "diff",
		render: () => "Use /diff to review this session's git changes and open them in a diff view.",
	},
	{
		id: "todo-command",
		bindings: [],
		requiresCommand: "todo",
		render: () => "Use /todo to show or edit the todo list without leaving the session.",
	},
	{
		id: "goal-command",
		bindings: [],
		requiresCommand: "goal",
		render: () => `Use /goal to set a persistent goal ${APP_NAME} keeps pursuing, then pause, resume, or clear it.`,
	},
	{
		id: "btw-command",
		bindings: [],
		requiresCommand: "btw",
		render: () => "Use /btw to ask a side question in a parallel session without disturbing this one.",
	},
	{
		id: "lookat-command",
		bindings: [],
		requiresCommand: "lookat",
		render: () => "Use /lookat to manage the vision-model chain the look_at tool uses for images and screenshots.",
	},
	{
		id: "mcp-command",
		bindings: [],
		requiresCommand: "mcp",
		render: () => "Use /mcp to inspect and manage the MCP servers wired into this session.",
	},
	{
		id: "rules-command",
		bindings: [],
		requiresCommand: "rules",
		render: () => "Use /rules to see which rules are loaded, and /reload-rules to re-read them mid-session.",
	},
	{
		id: "hooks-command",
		bindings: [],
		requiresCommand: "hooks",
		render: () => "Use /hooks to list loaded hook sources and their diagnostics.",
	},
	{
		id: "websearch-command",
		bindings: [],
		requiresCommand: "websearch",
		render: () => "Use /websearch to check which web-search provider is currently active.",
	},
] satisfies readonly TipDefinition[];
