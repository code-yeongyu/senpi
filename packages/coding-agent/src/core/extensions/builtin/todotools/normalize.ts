import { DEFAULT_INIT_PHASE, type TodoOpEntry, type TodoOperation, type TodoPhase } from "./todo-types.ts";

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

/**
 * A weaker tool-calling model sometimes wraps the phased list one level too deep: as a nested
 * array (`[[{phase, items}]]`, or one inner array per phase) or as an object wrapper
 * (`{list: [...]}`). Both carry the canonical list unambiguously, so unwrap them before schema
 * validation. Anything that is not a pure wrapper, or that unwraps to an empty list (which would turn a
 * malformed call into a list clear), is returned as-is and fails validation as before.
 */
function unwrapTodoList(value: unknown): unknown {
	let current = value;
	for (let depth = 0; depth < 3; depth++) {
		if (Array.isArray(current) && current.length > 0 && current.every((entry) => Array.isArray(entry))) {
			current = current.flat();
		} else if (
			isRecord(current) &&
			!Array.isArray(current) &&
			Object.keys(current).length === 1 &&
			"list" in current
		) {
			current = current.list;
		} else {
			break;
		}
	}
	return Array.isArray(current) && current.length > 0 ? current : value;
}

/**
 * Reserved string key under which `prepareTodoArguments` carries its correction notices to
 * `execute`. `validateToolArguments` clones prepared arguments with `structuredClone`, which
 * drops symbol keys, so the channel must be a string key; `execute` strips it before
 * `normalizeTodoParams` and prepends the notices. The key is never persisted or rendered,
 * but prepared arguments flow to the agent loop's `beforeToolCall`/`afterToolCall` hooks, so
 * extension `tool_call`/`tool_result` hooks may observe it on the arguments they receive.
 */
export const TODO_PREPARED_CORRECTIONS_KEY = "__todoPreparedCorrections";

function isPhaseRecord(value: unknown): value is { phase: string; items: unknown[] } {
	return isRecord(value) && typeof value.phase === "string" && Array.isArray(value.items);
}

function isContentRecord(value: unknown): value is { content: string } {
	return isRecord(value) && typeof value.content === "string";
}

function quoted(values: readonly string[]): string {
	return values.map((value) => JSON.stringify(value)).join(", ");
}

/**
 * Rewrites near-canonical `list` entries (senpi#5332) to the canonical shape: an entry whose
 * `items` are all nested `{phase, items}` records is replaced by them, `items` entries that
 * are records carrying a string `content` become that string, entries with missing or empty
 * `items` and stray string entries are dropped, and entries with tasks but no usable `phase`
 * name get sequential default names. An `items` array that mixes strings with phase records
 * is ambiguous and returns `null`, as does nothing else here: the caller then leaves the
 * whole call untouched so validation rejects it as before. The input array and its entries
 * are never mutated; when nothing changes, the same array reference is returned.
 */
function normalizeTodoListEntries(input: readonly unknown[], notices: string[]): unknown[] | null {
	let list = [...input];
	let changed = false;

	const promotedOuter: string[] = [];
	for (let depth = 0; depth < 5; depth++) {
		const next: unknown[] = [];
		let promotedThisPass = false;
		for (const entry of list) {
			if (isPhaseRecord(entry) && entry.items.length > 0 && entry.items.every(isPhaseRecord)) {
				next.push(...entry.items);
				promotedOuter.push(entry.phase);
				promotedThisPass = true;
			} else {
				next.push(entry);
			}
		}
		if (!promotedThisPass) break;
		list = next;
	}
	if (promotedOuter.length > 0) {
		changed = true;
		notices.push(
			`[auto-corrected] "list" ${promotedOuter.length === 1 ? "entry" : "entries"} ${quoted(promotedOuter)} contained only nested phases; promoted the nested phases to top level. Each "list" entry is exactly one phase: {"phase":"<name>","items":["<task>", ...]}`,
		);
	}

	let unwrappedContent = 0;
	for (let index = 0; index < list.length; index++) {
		const entry = list[index];
		if (!isPhaseRecord(entry)) continue;
		const mapped = entry.items.map((item) => {
			if (isContentRecord(item) && !isPhaseRecord(item)) {
				unwrappedContent += 1;
				return item.content;
			}
			return item;
		});
		// Strings and nested phase records in one items array cannot be told apart, so no
		// correction may guess: leave the whole call to validation.
		if (mapped.some((item) => typeof item === "string") && mapped.some(isPhaseRecord)) return null;
		if (!mapped.every((item) => typeof item === "string")) continue;
		if (mapped.some((item, position) => item !== entry.items[position])) {
			list[index] = { ...entry, items: mapped };
			changed = true;
		}
	}
	if (unwrappedContent > 0) {
		notices.push(
			`[auto-corrected] unwrapped ${unwrappedContent} "items" ${unwrappedContent === 1 ? "entry" : "entries"} carrying a "content" field into their task strings. "items" holds only task strings.`,
		);
	}

	const withoutEmptyPhases = list.filter((entry) => {
		if (!isRecord(entry)) return true;
		if (typeof entry.phase !== "string" && !("items" in entry)) return true;
		return entry.items !== undefined && (!Array.isArray(entry.items) || entry.items.length > 0);
	});
	if (withoutEmptyPhases.length !== list.length) {
		changed = true;
		const dropped = list.length - withoutEmptyPhases.length;
		notices.push(
			`[auto-corrected] dropped ${dropped} "list" ${dropped === 1 ? "entry" : "entries"} with no tasks. Every phase needs at least one task in "items".`,
		);
		list = withoutEmptyPhases;
	}

	const hasObjectEntries = list.some((entry) => isRecord(entry));
	const strayStrings = list.filter((entry) => typeof entry === "string");
	if (strayStrings.length > 0 && hasObjectEntries) {
		changed = true;
		notices.push(
			`[auto-corrected] dropped ${strayStrings.length} stray ${strayStrings.length === 1 ? "entry" : "entries"} from "list". "list" holds only phase objects: {"phase":"<name>","items":["<task>", ...]}`,
		);
		list = list.filter((entry) => typeof entry !== "string");
	}

	const usedNames = new Set<string>();
	for (const entry of list) {
		if (isRecord(entry) && typeof entry.phase === "string" && entry.phase.trim() !== "") usedNames.add(entry.phase);
	}
	const generatedNames: string[] = [];
	for (let index = 0; index < list.length; index++) {
		const entry = list[index];
		if (
			!isRecord(entry) ||
			!Array.isArray(entry.items) ||
			entry.items.length === 0 ||
			!entry.items.every((item) => typeof item === "string") ||
			(typeof entry.phase === "string" && entry.phase.trim() !== "")
		) {
			continue;
		}
		let counter = 1;
		let name = DEFAULT_INIT_PHASE;
		while (usedNames.has(name)) {
			counter += 1;
			name = `${DEFAULT_INIT_PHASE} ${counter}`;
		}
		usedNames.add(name);
		generatedNames.push(name);
		const { phase: _replaced, ...rest } = entry;
		list[index] = { phase: name, ...rest };
		changed = true;
	}
	if (generatedNames.length > 0) {
		notices.push(
			`[auto-corrected] named ${generatedNames.length} "list" ${generatedNames.length === 1 ? "entry" : "entries"} without a phase name: ${quoted(generatedNames)}. Pass "phase" explicitly: {"phase":"<name>","items":["<task>", ...]}`,
		);
	}

	return changed ? list : (input as unknown[]);
}

/**
 * The todo tool's `prepareArguments`: rewrites near-canonical shapes (senpi#5148 wrappers,
 * senpi#5332 list/op corrections) to the canonical one before schema validation. Any call a
 * rule does not correct is returned as the SAME reference, and a correction that would leave
 * `list` empty is abandoned entirely so the malformed call still fails validation instead of
 * clearing the todo list. A caller-sent `TODO_PREPARED_CORRECTIONS_KEY` is never trusted
 * (senpi#5332): it is dropped on a copy before any rule runs, and when that removal is the
 * only change the stripped copy is returned instead of the same reference.
 */
export function prepareTodoArguments(input: unknown): unknown {
	if (!isRecord(input) || Array.isArray(input)) return input;
	const { [TODO_PREPARED_CORRECTIONS_KEY]: _callerSent, ...stripped } = input;
	const args: Record<string, unknown> = TODO_PREPARED_CORRECTIONS_KEY in input ? stripped : input;
	const notices: string[] = [];
	let draft: Record<string, unknown> | undefined;
	const revise = (mutate: (draftArgs: Record<string, unknown>) => void): void => {
		draft ??= { ...args };
		mutate(draft);
	};

	const rawOp = args.op;
	let op = rawOp;
	if (typeof rawOp === "string" && !isOperation(rawOp)) {
		// Only stray leading/trailing characters that are neither letters nor digits are
		// stripped ("view}", " done."); digits survive, so "rm 2" and " 2rm" stay invalid
		// ops, and the middle must already be exactly a known operation ("re-move").
		const stripped = rawOp.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
		// A corrected rm/done/drop/start without a non-blank "task"/"phase" would act on every
		// task (senpi#5332 review): leave such a call for validation to reject unchanged.
		const carriesTarget = nonBlank(args.task) !== undefined || nonBlank(args.phase) !== undefined;
		const needsTarget = stripped === "rm" || stripped === "done" || stripped === "drop" || stripped === "start";
		if (isOperation(stripped) && (!needsTarget || carriesTarget)) {
			op = stripped;
			revise((draftArgs) => {
				draftArgs.op = stripped;
			});
			notices.push(
				`[auto-corrected] "op" ${JSON.stringify(rawOp)} is not a known operation; used "${stripped}" after stripping stray leading or trailing non-alphanumeric characters. Pass "op" exactly: init, start, done, rm, drop, append, view.`,
			);
		}
	}

	// A `list` always means init, so its rules also run when op is missing. The top-level
	// `items` rules do not: an op-less `items` call is only inferred as init against an empty
	// list and as append with a phase, so promoting or unwrapping it here would bypass those
	// guards (senpi#5332 review). Only an explicit "init" — after the op correction above —
	// may adopt the `items` rules.
	if (op === undefined || op === "init") {
		if ("list" in args) {
			let listValue: unknown = args.list;
			if (typeof listValue === "string") {
				try {
					const parsed: unknown = JSON.parse(listValue);
					if (Array.isArray(parsed) || isRecord(parsed)) {
						listValue = parsed;
						notices.push(
							'[auto-corrected] "list" was sent as a JSON string; parsed it. Pass "list" as an array of phases.',
						);
					}
				} catch {
					// Unparseable: leave the string for validation to reject.
				}
			}
			let candidate: unknown = unwrapTodoList(listValue);
			if (Array.isArray(candidate)) {
				const normalized = normalizeTodoListEntries(candidate, notices);
				if (normalized === null) return args;
				candidate = normalized;
			}
			// A correction must never widen a malformed call into a list clear.
			if (Array.isArray(candidate) && candidate.length === 0) return args;
			if (candidate !== args.list) {
				const adopted = candidate;
				revise((draftArgs) => {
					draftArgs.list = adopted;
				});
			}
		}
	}

	if (op === "init" && args.list === undefined && Array.isArray(args.items) && args.items.length > 0) {
		const items = args.items;
		if (items.every(isPhaseRecord)) {
			const normalized = normalizeTodoListEntries([...items], notices);
			if (normalized === null || normalized.length === 0) return args;
			const adopted = normalized;
			revise((draftArgs) => {
				draftArgs.list = adopted;
				delete draftArgs.items;
			});
			notices.push(
				'[auto-corrected] "items" held phase records; moved them to "list". Pass phases under "list": {"op":"init","list":[{"phase":"<name>","items":["<task>", ...]}]}',
			);
		} else {
			const mapped = items.map((item) => (isContentRecord(item) && !isPhaseRecord(item) ? item.content : item));
			if (mapped.some((item) => typeof item === "string") && mapped.some(isPhaseRecord)) return args;
			const unwrapped = items.filter((item) => isContentRecord(item) && !isPhaseRecord(item)).length;
			if (unwrapped > 0 && mapped.every((item) => typeof item === "string")) {
				revise((draftArgs) => {
					draftArgs.items = mapped;
				});
				notices.push(
					`[auto-corrected] unwrapped ${unwrapped} top-level "items" ${unwrapped === 1 ? "entry" : "entries"} carrying a "content" field into their task strings. "items" holds only task strings.`,
				);
			}
		}
	}

	if (!draft) return args;
	return notices.length > 0 ? { ...draft, [TODO_PREPARED_CORRECTIONS_KEY]: [...notices] } : draft;
}

/**
 * Splits the prepare-time correction notices off prepared arguments (see
 * `TODO_PREPARED_CORRECTIONS_KEY`): the arguments without the reserved key, plus the notices
 * to prepend to `normalizeTodoParams`'s own corrections.
 */
export function splitPreparedCorrections(args: Record<string, unknown>): {
	args: Record<string, unknown>;
	corrections: string[];
} {
	const { [TODO_PREPARED_CORRECTIONS_KEY]: notices, ...rest } = args;
	return {
		args: rest,
		corrections: Array.isArray(notices)
			? notices.filter((notice): notice is string => typeof notice === "string")
			: [],
	};
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
	const corrections: string[] = [];
	if (op === "start" || op === "done" || op === "drop" || op === "rm") {
		// GPT-5.x-style function calling serializes every schema property and pads
		// omitted strings with "". When BOTH targets arrive blank on rm, the only
		// documented no-target rm form is a bulk clear, so the padding is
		// unambiguous — drop it instead of demanding a field omission the
		// serializer cannot express. Single-blank targets and the destructive-bulk
		// ops (start/done/drop) still error, so a truncated single target never
		// widens into a bulk action.
		if (op === "rm" && isBlank(raw.task) && isBlank(raw.phase)) {
			corrections.push(
				'[auto-corrected] "task" and "phase" were both blank; treated as a bulk clear. ' +
					'For a single target pass the exact text: {"op":"rm","task":"<exact task content>"}.',
			);
		} else if (isBlank(raw.task) && !phase) {
			return error('Blank "task": pass the exact task text, or omit the field entirely for a bulk operation.');
		} else if (isBlank(raw.phase) && !task) {
			return error('Blank "phase": pass the exact phase text, or omit the field entirely for a bulk operation.');
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
