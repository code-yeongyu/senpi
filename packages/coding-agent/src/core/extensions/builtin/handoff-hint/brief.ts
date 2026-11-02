import type { SessionEntry } from "../../../session-manager.ts";
import type { Goal } from "../goal/types.ts";
import { getLatestTodoStateFromBranchEntries } from "../todotools/todo-storage.ts";

export interface HandoffBriefInput {
	readonly entries: readonly SessionEntry[];
	readonly goal: Goal | null;
	readonly cwd: string;
	readonly modelLabel: string | undefined;
	readonly previousSessionFile: string | undefined;
	readonly contextTokens: number;
}

const MAX_TEXT_CHARS = 1500;
const MAX_FILES = 20;
const MAX_TODOS = 20;
const MAX_TODO_CHARS = 200;
const PATH_TOOLS = new Set(["read", "edit", "write", "multiedit", "ls"]);
const PATCH_FILE_LINE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

function trim(text: string, max = MAX_TEXT_CHARS): string {
	const flat = text.trim();
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function pathsOfCall(name: string, args: unknown): string[] {
	if (typeof args !== "object" || args === null) return [];
	const record = args as Record<string, unknown>;
	if (PATH_TOOLS.has(name)) {
		const path = record.path ?? record.file_path;
		return typeof path === "string" ? [path] : [];
	}
	const patch = record.patch ?? record.input;
	if (name === "apply_patch" && typeof patch === "string") {
		return [...patch.matchAll(PATCH_FILE_LINE)].map((match) => match[1].trim());
	}
	return [];
}

function touchedFiles(entries: readonly SessionEntry[]): string[] {
	const seen = new Set<string>();
	for (let index = entries.length - 1; index >= 0 && seen.size < MAX_FILES; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
		for (const part of [...parts].reverse()) {
			if (part.type !== "toolCall") continue;
			for (const path of pathsOfCall(part.name, part.arguments)) {
				if (seen.size >= MAX_FILES) break;
				seen.add(path);
			}
		}
	}
	return [...seen];
}

function lastText(entries: readonly SessionEntry[], role: "user" | "assistant"): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== role) continue;
		const text = textOf(entry.message.content);
		if (text.trim().length > 0) return trim(text);
	}
	return "";
}

const STATUS_LABEL: Record<string, string> = { in_progress: "in progress", pending: "open" };

export function buildHandoffBrief(input: HandoffBriefInput): string {
	const lines: string[] = [
		`Handoff from an earlier session${input.previousSessionFile ? ` (${input.previousSessionFile})` : ""}.`,
		`That session had grown to about ${Math.round(input.contextTokens / 1000)}k tokens, so only this brief carries over. Read the old session file if you need more detail.`,
	];
	if (input.goal && input.goal.status === "active") lines.push("", `Goal: ${trim(input.goal.objective)}`);
	const open = getLatestTodoStateFromBranchEntries(input.entries).phases.flatMap((phase) =>
		phase.tasks
			.filter((task) => task.status === "in_progress" || task.status === "pending")
			.map((task) => `- [${STATUS_LABEL[task.status]}] ${phase.name}: ${trim(task.content, MAX_TODO_CHARS)}`),
	);
	if (open.length > 0) {
		lines.push("", "Open todos:", ...open.slice(0, MAX_TODOS));
		if (open.length > MAX_TODOS) lines.push(`- and ${open.length - MAX_TODOS} more`);
	}
	const ask = lastText(input.entries, "user");
	if (ask) lines.push("", "Last request:", ask);
	const answer = lastText(input.entries, "assistant");
	if (answer) lines.push("", "Last answer:", answer);
	const files = touchedFiles(input.entries);
	if (files.length > 0) lines.push("", "Files touched, most recent first:", ...files.map((path) => `- ${path}`));
	lines.push("", `Working directory: ${input.cwd}${input.modelLabel ? `. Model: ${input.modelLabel}` : ""}.`);
	return lines.join("\n");
}
