// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { partialStrikethrough, strikeRevealCount } from "../../../../../modes/interactive/components/todo-strike.ts";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../../../types.ts";
import { normalizeTodoParams } from "../normalize.ts";
import { TODO_TOOL_DESCRIPTION } from "../prompt.ts";
import {
	applyParams,
	clonePhases,
	findTaskByContent,
	formatSummary,
	getCompletionTransitions,
	getTodoMarker,
	nextActionableTask,
	sanitizeTodoText,
	TODO_STATE_ENTRY_TYPE,
	type TodoCompletionTransition,
	type TodoOperation,
	type TodoPhase,
	type TodoStateEntry,
	type TodoToolDetails,
} from "../state.ts";

const TodoOperationSchema = Type.Union(
	[
		Type.Literal("init"),
		Type.Literal("start"),
		Type.Literal("done"),
		Type.Literal("rm"),
		Type.Literal("drop"),
		Type.Literal("append"),
		Type.Literal("view"),
	],
	{ description: "Operation to perform. Required — always pass it explicitly." },
);

const TodoPhaseInputSchema = Type.Object({
	phase: Type.String({ description: "Phase name" }),
	items: Type.Array(Type.String({ description: "Task content" }), {
		description: "Tasks for this phase",
		minItems: 1,
	}),
});

export const TODO_PARAMS_SCHEMA = Type.Object({
	op: Type.Optional(TodoOperationSchema),
	list: Type.Optional(Type.Array(TodoPhaseInputSchema, { description: "Phased task list for init" })),
	task: Type.Optional(Type.String({ description: "Exact task text copied from the previous todo result" })),
	phase: Type.Optional(Type.String({ description: "Exact phase name copied from the previous todo result" })),
	// Keep this unconstrained at the schema boundary. init and append return
	// operation-specific errors, while unrelated operations may ignore it.
	items: Type.Optional(
		Type.Array(Type.String({ description: "Task content" }), { description: "Task texts to append" }),
	),
});

type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;

type TodoAccessors = {
	getCurrentPhases: () => TodoPhase[];
	setCurrentPhases: (phases: TodoPhase[]) => void;
	syncWidget: (ctx: ExtensionContext, completedTasks?: readonly TodoCompletionTransition[]) => void;
};

function countInitItems(params: TodoParams): { phases: number; tasks: number } {
	if (params.list) {
		return {
			phases: params.list.length,
			tasks: params.list.reduce((total, phase) => total + phase.items.length, 0),
		};
	}
	if (params.items) return { phases: params.items.length > 0 ? 1 : 0, tasks: params.items.length };
	return { phases: 0, tasks: 0 };
}

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function renderCallLabel(params: TodoParams): string {
	switch (params.op) {
		case "init": {
			const counts = countInitItems(params);
			return `todo init (${countLabel(counts.phases, "phase")}, ${countLabel(counts.tasks, "task")})`;
		}
		case "append":
			return `todo append: ${sanitizeTodoText(params.phase ?? "") || "(missing phase)"} (${countLabel(
				params.items?.length ?? 0,
				"item",
			)})`;
		case "start":
		case "done":
		case "drop":
			return `todo ${params.op}: ${sanitizeTodoText(params.task ?? params.phase ?? "") || "(missing target)"}`;
		case "rm":
			return `todo rm: ${sanitizeTodoText(params.task ?? params.phase ?? "all") || "all"}`;
		case "view":
			return "todo view";
		// Normalization can rescue a call that omitted `op`; label it generically until
		// execute resolves the effective operation. Listing `undefined` explicitly (instead
		// of `default`) keeps this switch exhaustive, so a new TodoOperation fails typecheck.
		case undefined:
			return "todo";
	}
}

export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	const pairs: ReadonlyArray<readonly [number, string]> = [
		[1000, "M"],
		[900, "CM"],
		[500, "D"],
		[400, "CD"],
		[100, "C"],
		[90, "XC"],
		[50, "L"],
		[40, "XL"],
		[10, "X"],
		[9, "IX"],
		[5, "V"],
		[4, "IV"],
		[1, "I"],
	];
	let remaining = oneBasedIndex;
	let output = "";
	for (const [value, symbol] of pairs) {
		while (remaining >= value) {
			output += symbol;
			remaining -= value;
		}
	}
	return output;
}

function formatPhaseHeader(name: string, index: number, theme: Theme): string {
	return theme.fg("accent", theme.bold(`${phaseRomanNumeral(index)}. ${sanitizeTodoText(name)}`));
}

function formatPhaseSummary(phase: TodoPhase, index: number, theme: Theme): string {
	const closed = phase.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
	return theme.fg(
		"dim",
		`${phaseRomanNumeral(index)}. ${sanitizeTodoText(phase.name)} — ${closed}/${phase.tasks.length} done`,
	);
}

function formatTaskLine(
	task: TodoPhase["tasks"][number],
	theme: Theme,
	completionKeys: ReadonlySet<string>,
	frame: number | undefined,
): string {
	const content = sanitizeTodoText(task.content);
	const line = `${getTodoMarker(task.status)} ${content}`;
	switch (task.status) {
		case "completed": {
			const reveal = completionKeys.has(task.content) ? strikeRevealCount(line, frame) : undefined;
			return reveal === undefined
				? theme.fg("dim", theme.strikethrough(line))
				: theme.fg(
						"dim",
						partialStrikethrough(line, reveal, (text) => theme.strikethrough(text)),
					);
		}
		case "in_progress":
			return theme.fg("accent", theme.bold(line));
		case "abandoned":
			return theme.fg("dim", line);
		case "pending":
			return line;
	}
}

function computeTouchedPhases(
	args: TodoParams,
	operation: TodoOperation | undefined,
	phases: readonly TodoPhase[],
	completedTasks: readonly TodoCompletionTransition[],
): Set<string> | null {
	const touched = new Set<string>();
	const activeTask = nextActionableTask(phases);
	if (activeTask) {
		const activePhase = phases.find((phase) => phase.tasks.includes(activeTask));
		if (activePhase) touched.add(activePhase.name);
	}
	for (const transition of completedTasks) touched.add(transition.phase);
	// Exhaustive over TodoOperation | undefined so adding an operation is a typecheck
	// failure here rather than a silent fall-through into target-scoped highlighting.
	switch (operation) {
		case "init":
			for (const phase of phases) touched.add(phase.name);
			break;
		case "start":
		case "done":
		case "drop":
		case "rm":
		case "append":
		case "view":
		case undefined: {
			if (args.phase) {
				const phase = phases.find((candidate) => candidate.name === args.phase);
				if (phase) touched.add(phase.name);
			}
			if (args.task) {
				const hit = findTaskByContent([...phases], args.task);
				if (hit) touched.add(hit.phase.name);
			}
			break;
		}
		default: {
			const _exhaustive: never = operation;
			return touched.size > 0 ? touched : null;
		}
	}
	return touched.size > 0 ? touched : null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function renderTodoPhases(
	phases: readonly TodoPhase[],
	completedTasks: readonly TodoCompletionTransition[],
	options: ToolRenderResultOptions,
	args: TodoParams,
	operation: TodoOperation | undefined,
	theme: Theme,
	frame: number | undefined,
): string {
	const visiblePhases = phases.filter((phase) => phase.tasks.length > 0);
	if (visiblePhases.length === 0) return "";

	const touched =
		options.expanded || visiblePhases.length === 1
			? null
			: computeTouchedPhases(args, operation, visiblePhases, completedTasks);
	const completionKeysByPhase = new Map<string, Set<string>>();
	for (const transition of completedTasks) {
		let completionKeys = completionKeysByPhase.get(transition.phase);
		if (!completionKeys) {
			completionKeys = new Set();
			completionKeysByPhase.set(transition.phase, completionKeys);
		}
		completionKeys.add(transition.content);
	}
	const lines: string[] = [];
	for (let index = 0; index < visiblePhases.length; index += 1) {
		const phase = visiblePhases[index];
		const oneBasedIndex = index + 1;
		if (touched && !touched.has(phase.name)) {
			lines.push(formatPhaseSummary(phase, oneBasedIndex, theme));
			continue;
		}
		lines.push(formatPhaseHeader(phase.name, oneBasedIndex, theme));
		const completionKeys = completionKeysByPhase.get(phase.name) ?? EMPTY_SET;
		for (const task of phase.tasks) lines.push(`  ${formatTaskLine(task, theme, completionKeys, frame)}`);
	}
	return lines.join("\n");
}

function getTextContent(result: AgentToolResult<TodoToolDetails>): string {
	return result.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n");
}

export function registerTodoTool(pi: ExtensionAPI, accessors: TodoAccessors): void {
	const tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA, TodoToolDetails, unknown> = {
		name: "todo",
		label: "Todo",
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet: "Track phased tasks with one op-based todo tool; reference tasks by their exact content.",
		promptGuidelines: [
			"Use one todo operation at a time; batch it with the real work rather than making a solo todo turn.",
			"Reference tasks and phases by their exact content/name; use view when the text is uncertain.",
			"Mark work done immediately and use drop for tasks that are no longer needed.",
		],
		parameters: TODO_PARAMS_SCHEMA,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<TodoToolDetails>> {
			const previousPhases = clonePhases(accessors.getCurrentPhases());
			const normalized = normalizeTodoParams(params as Record<string, unknown>, previousPhases);
			if (normalized.error || !normalized.entry) {
				const error =
					normalized.error ?? 'Missing "op". Example: {"op":"init","list":[{"phase":"Setup","items":["..."]}]}';
				throw new Error(`${error}\n\n${formatSummary(previousPhases, [], true)}`);
			}
			const entry = normalized.entry;
			const corrections = normalized.corrections;
			const readOnly = entry.op === "view";
			const applied = readOnly
				? { phases: previousPhases, errors: [] as string[] }
				: applyParams(clonePhases(previousPhases), entry, corrections);
			if (applied.errors.length > 0) throw new Error(formatSummary(previousPhases, applied.errors, readOnly));
			const completedTasks = readOnly ? [] : getCompletionTransitions(previousPhases, applied.phases);
			if (!readOnly) {
				pi.appendEntry(TODO_STATE_ENTRY_TYPE, {
					schema: "v2",
					phases: clonePhases(applied.phases),
				} satisfies TodoStateEntry);
				accessors.setCurrentPhases(clonePhases(applied.phases));
				accessors.syncWidget(ctx, completedTasks);
			}

			const details: TodoToolDetails = {
				op: entry.op,
				phases: clonePhases(applied.phases),
				storage: ctx.sessionManager.getSessionFile() ? "session" : "memory",
			};
			if (corrections.length > 0) details.corrections = corrections;
			if (completedTasks.length > 0) details.completedTasks = completedTasks;
			const summary = formatSummary(applied.phases, [], readOnly);
			const text = corrections.length > 0 ? `${corrections.join("\n")}\n\n${summary}` : summary;

			return { content: [{ type: "text", text }], details };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(renderCallLabel(args))), 0, 0);
		},
		renderResult(result, options, theme, context: ToolRenderContext<unknown, TodoParams>) {
			if (context.isError) {
				return new Text(theme.fg("toolOutput", getTextContent(result)), 0, 0);
			}
			const phases = result.details?.phases ?? [];
			const rendered = renderTodoPhases(
				phases,
				result.details?.completedTasks ?? [],
				options,
				context.args,
				result.details?.op,
				theme,
				context.spinnerFrame,
			);
			const text = rendered || getTextContent(result) || "Todo list is empty.";
			return new Text(text, 0, 0);
		},
	};

	pi.registerTool(tool);
}
