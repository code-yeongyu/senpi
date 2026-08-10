import { APP_NAME } from "../../../../config.ts";
import type { TipDefinition } from "./types.ts";

export const SESSION_TIPS = [
	{
		id: "favorite-models-command",
		bindings: [],
		render: () => "Use /favorite-models to choose and reorder the models in your rotation.",
	},
	{
		id: "tree-command",
		bindings: [],
		render: () => "Use /tree to revisit earlier points and switch between session branches.",
	},
	{
		id: "fork-command",
		bindings: [],
		render: () => "Use /fork to create a separate session from an earlier user message.",
	},
	{
		id: "clone-session",
		bindings: [],
		render: () => "Use /clone to duplicate the current branch into its own session before trying something risky.",
	},
	{
		id: "continue-session",
		bindings: [],
		render: () => `${APP_NAME} -c continues your most recent session; ${APP_NAME} -r opens the session picker.`,
	},
	{
		id: "session-name",
		bindings: [],
		render: () => "Use /name <name> to label a session so it is easy to spot in the footer and in /resume.",
	},
	{
		id: "session-info",
		bindings: [],
		render: () => "Use /session to see the session file, id, message count, tokens, and cost.",
	},
	{
		id: "export-share",
		bindings: [],
		render: () => "Use /export to write the session to HTML or JSONL, or /share to upload it as a private gist link.",
	},
	{
		id: "compact-command",
		bindings: [],
		render: () => "Use /compact to compact context now, or /compact <prompt> to tell the summarizer what to keep.",
	},
	{
		id: "auto-compaction",
		bindings: [],
		render: () =>
			"Auto-compaction is on by default - the (auto) marker in the footer shows it; tune it with compaction.* in settings.json.",
	},
] satisfies readonly TipDefinition[];
