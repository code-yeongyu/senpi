// Codex-style "File operations" tuning block.
//
// This is the senpi equivalent of codex-rs/core/gpt_5_2_prompt.md's Task
// execution + Shell commands + apply_patch sections, collapsed into a single
// paragraph. It exists because GPT models have a strong pre-training prior
// toward "use python/sed/heredoc to manipulate files", which the function-call
// schema alone is too weak to override - codex itself learned this and added an
// explicit "Do not use python scripts to attempt to output larger chunks of a
// file" line by GPT-5.1.
//
// The block is rendered from the session's ACTIVE tool names, never from the
// preset that happens to be resolved (#1968). `apply_patch` only exists for GPT
// ids on an OpenAI-family API, so a preset-driven block told a Grok 4.5 user -
// or any GPT preset pinned onto anthropic-messages, bedrock or a custom API -
// to route every edit through a tool their session could never activate.
//
// Wording rules:
// - Positive routing first ("use X"), negative guard second ("do not Y").
//   Negative-only directives compete with priors and lose; positive routing
//   gives the model the verb to reach for. This is also why the routing
//   sentence names one concrete verb per session instead of hedging across
//   both ("when apply_patch is active, ... otherwise ..."): a conditional the
//   model has to resolve is weaker than an instruction it can follow.
// - Name `read` and the `grep` tool only when the session actually has them,
//   for the same reason. The `grep` tool note prevents the model from invoking
//   `grep`/`rg` through bash when senpi exposes a ripgrep-backed `grep` already.
// - Forbid python/sed/awk heredoc-driven shell mutations explicitly, in every
//   branch that routes an edit at all.
// - Mirror codex's "do not waste tokens re-reading after apply_patch" guard,
//   which only makes sense where that tool exists.

const APPLY_PATCH_TOOL = "apply_patch";
const EDIT_TOOL_NAMES = ["edit", "write"] as const;
const READ_TOOL = "read";
const GREP_TOOL = "grep";

export type FileMutationMode = "apply-patch" | "edit-write" | "none";

export interface FileMutationRouting {
	mode: FileMutationMode;
	tools: string[];
}

// `apply_patch` wins when present because gpt-apply-patch swaps `edit`/`write` out for it.
export function resolveFileMutationRouting(toolNames: readonly string[]): FileMutationRouting {
	if (toolNames.includes(APPLY_PATCH_TOOL)) {
		return { mode: "apply-patch", tools: [APPLY_PATCH_TOOL] };
	}
	const editTools = EDIT_TOOL_NAMES.filter((name) => toolNames.includes(name));
	if (editTools.length > 0) {
		return { mode: "edit-write", tools: editTools };
	}
	return { mode: "none", tools: [] };
}

function formatToolList(tools: readonly string[]): string {
	const quoted = tools.map((name) => `\`${name}\``);
	if (quoted.length <= 1) {
		return quoted[0] ?? "";
	}
	return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

export function buildFileOperationsTuning(options: { toolNames: readonly string[] }): string {
	const { toolNames } = options;
	const routing = resolveFileMutationRouting(toolNames);
	const paragraphs: string[] = [];

	if (routing.mode !== "none") {
		paragraphs.push(
			`Use ${formatToolList(routing.tools)} for ALL file edits and creations. Do NOT write or modify files via bash heredoc (\`cat >\`, \`echo > \`), \`sed -i\`, \`awk -i\`, or inline \`python\`/\`python3 -c\` scripts.`,
		);
	}

	if (toolNames.includes(READ_TOOL)) {
		paragraphs.push(
			"Use `read` for ALL file inspection. Do NOT substitute `cat`, `sed`, `head`, `tail`, or inline `python` invoked through bash.",
		);
	}

	if (toolNames.includes(GREP_TOOL)) {
		paragraphs.push(
			"For text or filename search, use the `grep` tool (ripgrep-backed, respects .gitignore). Do NOT shell out to `grep` or `rg` through bash for the same purpose.",
		);
	}

	if (routing.mode === "apply-patch") {
		paragraphs.push(
			"Do not re-read a file immediately after a successful `apply_patch`; the call returns failure directly if the patch did not apply.",
		);
	}

	if (paragraphs.length === 0) {
		return "";
	}
	return ["## File operations", ...paragraphs].join("\n\n");
}
