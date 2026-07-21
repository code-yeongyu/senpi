// /todo slash command: user-facing todo management.
//
// Ported and adapted from oh-my-pi's
// `packages/coding-agent/src/modes/controllers/todo-command-controller.ts`
// (MIT — see NOTICE.md). senpi adaptations: the command registers through the
// extension API, edits happen in the built-in `ctx.ui.editor` overlay instead
// of a suspended external $EDITOR, and user edits persist as `senpi.todo-state`
// entries with `source: "user"` so the branch scanner and compaction bridge
// pick them up unchanged.

import { readFile, writeFile } from "node:fs/promises";
import { copyToClipboard } from "../../../../utils/clipboard.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../types.ts";
import { markdownToPhases, phasesToMarkdown, resolveTodoMarkdownPath } from "./markdown.ts";
import {
	applyOpsToPhases,
	clonePhases,
	DEFAULT_INIT_PHASE,
	TODO_STATE_ENTRY_TYPE,
	type TodoItem,
	type TodoPhase,
	type TodoStateEntry,
} from "./state.ts";

const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Edit todos as Markdown in an overlay",
	"  /todo copy                         Copy todos as Markdown to clipboard",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or created",
	"  /todo start  <task>                Mark task in_progress (fuzzy match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

const VERBS = ["edit", "copy", "export", "import", "append", "start", "done", "drop", "rm", "help"] as const;

export type TodoCommandAccessors = {
	getCurrentPhases: () => TodoPhase[];
	setCurrentPhases: (phases: TodoPhase[]) => void;
	syncWidget: (ctx: ExtensionContext) => void;
};

/** Tokenizer honoring double-quoted strings and backslash escapes. */
export function tokenizeTodoArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (char === "\\" && index + 1 < input.length) {
			current += input[index + 1];
			index += 1;
			continue;
		}
		if (char === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Exact name first, then unique prefix, then unique substring (case-insensitive). */
export function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	const byName = phases.find((phase) => phase.name.toLowerCase() === q);
	if (byName) return byName;
	const prefixMatches = phases.filter((phase) => phase.name.toLowerCase().startsWith(q));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter((phase) => phase.name.toLowerCase().includes(q));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

/** Exact content first, then unique substring; ambiguity resolved toward open work. */
export function findTaskFuzzy(phases: TodoPhase[], query: string): { task: TodoItem; phase: TodoPhase } | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	const open = matches.filter((hit) => hit.task.status === "in_progress" || hit.task.status === "pending");
	if (open.length === 1) return open[0];
	return undefined;
}

function titleCaseWords(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function titleCaseSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function buildUserEditReminder(action: string, phases: readonly TodoPhase[], removed: boolean): string {
	const markdown = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	const lines = ["<system-reminder>", `The user manually modified the todo list (${action}).`];
	if (removed) {
		lines.push(
			phases.length === 0
				? "The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list."
				: "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
		);
	}
	lines.push("Current todo list:", "", markdown, "</system-reminder>");
	return lines.join("\n");
}

export function registerTodoCommand(pi: ExtensionAPI, accessors: TodoCommandAccessors): void {
	function commit(
		ctx: ExtensionCommandContext,
		nextPhases: TodoPhase[],
		action: string,
		options?: { removed?: boolean },
	): void {
		accessors.setCurrentPhases(clonePhases(nextPhases));
		pi.appendEntry(TODO_STATE_ENTRY_TYPE, {
			schema: "v2",
			phases: clonePhases(nextPhases),
			source: "user",
			action,
		} satisfies TodoStateEntry & { source: string; action: string });
		accessors.syncWidget(ctx);
		pi.sendMessage(
			{
				customType: "todotools.user-edit",
				content: buildUserEditReminder(action, nextPhases, options?.removed ?? false),
				display: false,
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
	}

	function showCurrent(ctx: ExtensionCommandContext): void {
		const phases = accessors.getCurrentPhases();
		if (phases.length === 0) {
			ctx.ui.notify("No todos. Use /todo append <task> to start one.", "info");
			return;
		}
		ctx.ui.notify(phasesToMarkdown(phases).trimEnd(), "info");
	}

	async function editInOverlay(ctx: ExtensionCommandContext): Promise<void> {
		const current = accessors.getCurrentPhases();
		const initialMarkdown =
			current.length > 0
				? phasesToMarkdown(current)
				: `# ${DEFAULT_INIT_PHASE}\n- [ ] (replace this with your tasks)\n`;
		const edited = await ctx.ui.editor("Edit todos (Markdown checklist)", initialMarkdown);
		if (edited === undefined || edited === initialMarkdown) {
			ctx.ui.notify("Todos unchanged.", "info");
			return;
		}
		const { phases, errors } = markdownToPhases(edited);
		if (errors.length > 0) {
			ctx.ui.notify(`Could not parse Markdown:\n  ${errors.join("\n  ")}`, "error");
			return;
		}
		commit(ctx, phases, "/todo edit");
		const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		ctx.ui.notify(`Todos updated: ${phases.length} phase(s), ${taskCount} task(s).`, "info");
	}

	async function copyMarkdown(ctx: ExtensionCommandContext): Promise<void> {
		const phases = accessors.getCurrentPhases();
		if (phases.length === 0) {
			ctx.ui.notify("No todos to copy.", "warning");
			return;
		}
		try {
			await copyToClipboard(phasesToMarkdown(phases));
			ctx.ui.notify("Copied todos as Markdown to clipboard.", "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function exportToFile(ctx: ExtensionCommandContext, rest: string): Promise<void> {
		const phases = accessors.getCurrentPhases();
		if (phases.length === 0) {
			ctx.ui.notify("No todos to export.", "warning");
			return;
		}
		try {
			const target = resolveTodoMarkdownPath(rest, ctx.cwd);
			await writeFile(target, phasesToMarkdown(phases), "utf8");
			ctx.ui.notify(`Wrote todos to ${target}`, "info");
		} catch (error) {
			ctx.ui.notify(`Failed to write todos: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	async function importFromFile(ctx: ExtensionCommandContext, rest: string): Promise<void> {
		let source = "";
		let content: string;
		try {
			source = resolveTodoMarkdownPath(rest, ctx.cwd);
			content = await readFile(source, "utf8");
		} catch (error) {
			ctx.ui.notify(`Failed to read todos: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const { phases, errors } = markdownToPhases(content);
		if (errors.length > 0) {
			ctx.ui.notify(`Could not parse ${source}:\n  ${errors.join("\n  ")}`, "error");
			return;
		}
		commit(ctx, phases, `/todo import ${source}`);
		const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		ctx.ui.notify(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`, "info");
	}

	function append(ctx: ExtensionCommandContext, rest: string): void {
		const tokens = tokenizeTodoArgs(rest);
		if (tokens.length === 0) {
			ctx.ui.notify("Usage: /todo append [<phase>] <task...>", "error");
			return;
		}

		const next = clonePhases(accessors.getCurrentPhases());
		let phaseName: string | undefined;
		let content: string;
		if (tokens.length === 1) {
			content = tokens[0];
		} else {
			phaseName = tokens[0];
			content = tokens.slice(1).join(" ");
		}

		let targetPhase: TodoPhase | undefined;
		if (phaseName) {
			targetPhase = findPhaseFuzzy(next, phaseName);
			if (!targetPhase) {
				targetPhase = { name: titleCaseWords(phaseName), tasks: [] };
				next.push(targetPhase);
			}
		} else if (next.length > 0) {
			targetPhase = next[next.length - 1];
		} else {
			targetPhase = { name: DEFAULT_INIT_PHASE, tasks: [] };
			next.push(targetPhase);
		}

		const finalContent = titleCaseSentence(content);
		targetPhase.tasks.push({ content: finalContent, status: "pending" });
		commit(ctx, next, `/todo append → ${targetPhase.name}`);
		ctx.ui.notify(`Appended to ${targetPhase.name}: ${finalContent}`, "info");
	}

	function start(ctx: ExtensionCommandContext, rest: string): void {
		if (!rest) {
			ctx.ui.notify("Usage: /todo start <task>", "error");
			return;
		}
		const current = accessors.getCurrentPhases();
		const hit = findTaskFuzzy(current, rest);
		if (!hit) {
			ctx.ui.notify(`No task matched "${rest}". Use /todo to list current tasks.`, "error");
			return;
		}
		const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
		if (errors.length > 0) {
			ctx.ui.notify(errors.join("; "), "error");
			return;
		}
		commit(ctx, phases, `/todo start ${hit.task.content}`);
		ctx.ui.notify(`Started: ${hit.task.content}`, "info");
	}

	function mutateStatus(ctx: ExtensionCommandContext, rest: string, target: "completed" | "abandoned"): void {
		const op = target === "completed" ? ("done" as const) : ("drop" as const);
		const current = accessors.getCurrentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			const { phases, errors } = applyOpsToPhases(current, [{ op }]);
			if (errors.length > 0) {
				ctx.ui.notify(errors.join("; "), "error");
				return;
			}
			commit(ctx, phases, `/todo ${op} (all)`);
			ctx.ui.notify(`Marked all tasks ${target}.`, "info");
			return;
		}

		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, task: taskHit.task.content }]);
			if (errors.length > 0) {
				ctx.ui.notify(errors.join("; "), "error");
				return;
			}
			commit(ctx, phases, `/todo ${op} ${taskHit.task.content}`);
			ctx.ui.notify(`Marked ${target}: ${taskHit.task.content}`, "info");
			return;
		}

		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, phase: phaseHit.name }]);
			if (errors.length > 0) {
				ctx.ui.notify(errors.join("; "), "error");
				return;
			}
			commit(ctx, phases, `/todo ${op} ${phaseHit.name}`);
			ctx.ui.notify(`Marked phase ${phaseHit.name} ${target}.`, "info");
			return;
		}

		ctx.ui.notify(`No task or phase matched "${trimmed}".`, "error");
	}

	function remove(ctx: ExtensionCommandContext, rest: string): void {
		const current = accessors.getCurrentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			commit(ctx, [], "/todo rm (all)", { removed: true });
			ctx.ui.notify("Cleared all todos.", "info");
			return;
		}
		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", task: taskHit.task.content }]);
			if (errors.length > 0) {
				ctx.ui.notify(errors.join("; "), "error");
				return;
			}
			commit(ctx, phases, `/todo rm ${taskHit.task.content}`, { removed: true });
			ctx.ui.notify(`Removed: ${taskHit.task.content}`, "info");
			return;
		}
		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", phase: phaseHit.name }]);
			if (errors.length > 0) {
				ctx.ui.notify(errors.join("; "), "error");
				return;
			}
			commit(ctx, phases, `/todo rm ${phaseHit.name}`, { removed: true });
			ctx.ui.notify(`Removed phase: ${phaseHit.name}`, "info");
			return;
		}
		ctx.ui.notify(`No task or phase matched "${trimmed}".`, "error");
	}

	pi.registerCommand("todo", {
		description: "Show or edit the todo list (edit/copy/export/import/append/start/done/drop/rm)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const matches = VERBS.filter((verb) => verb.startsWith(prefix));
			if (matches.length === 0) return null;
			return matches.map((verb) => ({ value: verb, label: verb }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (!trimmed) {
				showCurrent(ctx);
				return;
			}
			const spaceIndex = trimmed.search(/\s/);
			const verb = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

			switch (verb) {
				case "edit":
					await editInOverlay(ctx);
					return;
				case "copy":
					await copyMarkdown(ctx);
					return;
				case "export":
					await exportToFile(ctx, rest);
					return;
				case "import":
					await importFromFile(ctx, rest);
					return;
				case "help":
				case "?":
					ctx.ui.notify(USAGE, "info");
					return;
				case "append":
					append(ctx, rest);
					return;
				case "start":
					start(ctx, rest);
					return;
				case "done":
					mutateStatus(ctx, rest, "completed");
					return;
				case "drop":
					mutateStatus(ctx, rest, "abandoned");
					return;
				case "rm":
					remove(ctx, rest);
					return;
				default:
					ctx.ui.notify(`Unknown /todo verb "${verb}".\n${USAGE}`, "error");
			}
		},
	});
}
