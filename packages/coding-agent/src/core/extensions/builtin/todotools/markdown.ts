// Markdown round-trip for the phased todo model.
//
// Ported and adapted from oh-my-pi's `packages/coding-agent/src/tools/todo.ts`
// (MIT — see NOTICE.md). Phases render as `# <name>` headings and tasks as
// checklist rows whose marker encodes status: `[ ]` pending, `[/]` in_progress,
// `[x]` completed, `[-]` abandoned.

import { isAbsolute, resolve } from "node:path";
import { DEFAULT_INIT_PHASE, normalizeInProgressTask, type TodoPhase, type TodoStatus } from "./state.ts";

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
};

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
};

/** Default file name for `/todo export` and `/todo import`. */
export const DEFAULT_TODO_MARKDOWN_FILE = "TODO.md";

/** Resolve a user-supplied path argument against cwd; empty input → TODO.md. */
export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = input.trim().replace(/^["']|["']$/g, "") || DEFAULT_TODO_MARKDOWN_FILE;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: readonly TodoPhase[]): string {
	if (phases.length === 0) return `# ${DEFAULT_INIT_PHASE}\n`;
	const out: string[] = [];
	for (let index = 0; index < phases.length; index += 1) {
		if (index > 0) out.push("");
		out.push(`# ${phases[index].name}`);
		for (const task of phases[index].tasks) {
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`);
		}
	}
	return `${out.join("\n")}\n`;
}

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(markdown: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	const lines = markdown.split(/\r?\n/);
	for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
		const trimmed = lines[lineNumber].trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: DEFAULT_INIT_PHASE, tasks: [] };
				phases.push(currentPhase);
			}
			const status = MARKER_TO_STATUS[taskMatch[1]];
			if (!status) {
				errors.push(`Line ${lineNumber + 1}: unknown status marker "[${taskMatch[1]}]" (use [ ], [x], [/], [-])`);
				continue;
			}
			currentPhase.tasks.push({ content: taskMatch[2].trim(), status });
			continue;
		}

		errors.push(`Line ${lineNumber + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}
