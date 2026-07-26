import type { TodoOpEntry, TodoOperation, TodoPhase } from "./state.ts";

export type TodoNormalization = {
	entry?: TodoOpEntry;
	corrections: string[];
	error?: string;
};

type Alias = "init" | "append";

const CONFLICTING_SHAPES =
	'conflicting shapes. Use {"op":"init","list":[...]} to replace the list or {"op":"append","phase":"<active phase>","items":[...]} to add tasks.';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOperation(value: unknown): value is TodoOperation {
	switch (value) {
		case "init":
		case "start":
		case "done":
		case "rm":
		case "drop":
		case "append":
		case "view":
			return true;
		default:
			return false;
	}
}

function strings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		parsed.push(item);
	}
	return parsed;
}

function list(value: unknown): TodoOpEntry["list"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed: NonNullable<TodoOpEntry["list"]> = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.phase !== "string") return undefined;
		const items = strings(item.items);
		if (!items) return undefined;
		parsed.push({ phase: item.phase, items });
	}
	return parsed;
}

function nonBlank(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isBlank(value: unknown): boolean {
	return typeof value === "string" && value.trim() === "";
}

function error(message: string): TodoNormalization {
	return { corrections: [], error: message };
}

function aliasCorrection(alias: Alias, inferred: boolean): string {
	const form =
		alias === "init" ? '{"op":"init","items":[...]}' : '{"op":"append","phase":"<active phase>","items":[...]}';
	if (inferred) {
		return `[auto-corrected] "op" was missing; interpreted as "${alias}" because "${alias}" was provided as an items alias. Always pass op explicitly: ${form}`;
	}
	return `[auto-corrected] "${alias}" was used as an items alias and folded into "items". Use: ${form}`;
}

function inferredCorrection(op: "init" | "append", reason: string, form: string): string {
	return `[auto-corrected] "op" was missing; interpreted as "${op}" because ${reason}. Always pass op explicitly: ${form}`;
}

function hasTasks(phases: readonly TodoPhase[]): boolean {
	return phases.some((phase) => phase.tasks.length > 0);
}

export function normalizeTodoParams(
	raw: Record<string, unknown>,
	currentPhases: readonly TodoPhase[],
): TodoNormalization {
	const rawOp = raw.op;
	if (rawOp === "view") return { entry: { op: "view" }, corrections: [] };
	if (rawOp !== undefined && !isOperation(rawOp)) return error('Invalid "op".');

	const op = isOperation(rawOp) ? rawOp : undefined;
	const task = nonBlank(raw.task);
	const phase = nonBlank(raw.phase);
	if (op === "start" || op === "done" || op === "drop" || op === "rm") {
		if (isBlank(raw.task) && !phase) {
			return error('Blank "task" — pass the exact task text, or omit the field entirely for a bulk operation.');
		}
		if (isBlank(raw.phase) && !task) {
			return error('Blank "phase" — pass the exact phase text, or omit the field entirely for a bulk operation.');
		}
	}

	const rawItems = strings(raw.items);
	const aliases: Array<{ name: Alias; items: string[] }> = [];
	for (const name of ["init", "append"] as const) {
		const items = strings(raw[name]);
		if (items && items.length > 0) aliases.push({ name, items });
	}
	if (aliases.length > 1) return error(CONFLICTING_SHAPES);
	if (aliases.length === 1 && rawItems && rawItems.length > 0) return error(CONFLICTING_SHAPES);

	const alias = aliases[0];
	let effectiveItems = rawItems && rawItems.length > 0 ? rawItems : undefined;
	let candidate: Alias | undefined;
	const corrections: string[] = [];
	if (alias) {
		if (op && op !== alias.name) return error(CONFLICTING_SHAPES);
		effectiveItems = alias.items;
		candidate = op ? undefined : alias.name;
		corrections.push(aliasCorrection(alias.name, !op));
	}

	const effectiveList = list(raw.list);
	const hasList = Boolean(effectiveList && effectiveList.length > 0);
	const hasItems = Boolean(effectiveItems && effectiveItems.length > 0);
	if (hasList && hasItems) return error(CONFLICTING_SHAPES);

	let effectiveOp = op;
	if (!effectiveOp) {
		if (candidate) {
			effectiveOp = candidate;
		} else if (hasList) {
			effectiveOp = "init";
			corrections.push(inferredCorrection("init", '"list" was provided', '{"op":"init","list":[...]}'));
		} else if (hasItems && phase) {
			effectiveOp = "append";
			corrections.push(
				inferredCorrection(
					"append",
					'"items" and "phase" were provided',
					'{"op":"append","phase":"<active phase>","items":[...]}',
				),
			);
		} else if (hasItems && !hasTasks(currentPhases)) {
			effectiveOp = "init";
			corrections.push(
				inferredCorrection("init", '"items" was provided to an empty todo list', '{"op":"init","items":[...]}'),
			);
		} else if (hasItems) {
			return error(
				'Missing "op": use {"op":"init","list":[...]} to replace the list, or {"op":"append","phase":"<active phase>","items":[...]} to add tasks.',
			);
		} else {
			return error('Missing "op". Example: {"op":"init","list":[{"phase":"Setup","items":["..."]}]}');
		}
	}

	switch (effectiveOp) {
		case "init": {
			if (task || (effectiveList && effectiveList.length === 0 && hasItems)) return error(CONFLICTING_SHAPES);
			const entry: TodoOpEntry = { op: "init" };
			if (effectiveList) entry.list = effectiveList;
			if (effectiveItems) entry.items = effectiveItems;
			if (phase) entry.phase = phase;
			return { entry, corrections };
		}
		case "start":
			if (phase || hasList || hasItems) return error(CONFLICTING_SHAPES);
			return { entry: task ? { op: "start", task } : { op: "start" }, corrections };
		case "done":
		case "drop":
		case "rm": {
			if (hasList || hasItems) return error(CONFLICTING_SHAPES);
			const entry: TodoOpEntry = { op: effectiveOp };
			if (task) entry.task = task;
			if (phase) entry.phase = phase;
			return { entry, corrections };
		}
		case "append":
			if (task || hasList) return error(CONFLICTING_SHAPES);
			return {
				entry: { op: "append", ...(phase ? { phase } : {}), ...(effectiveItems ? { items: effectiveItems } : {}) },
				corrections,
			};
		case "view":
			return { entry: { op: "view" }, corrections: [] };
	}
}
