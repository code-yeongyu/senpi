// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../../../types.ts";
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
	type TodoPhase,
	type TodoStateEntry,
	type TodoToolDetails,
} from "../state.ts";

const TodoOperationSchema = Type.Union([
	Type.Literal("init"),
	Type.Literal("start"),
	Type.Literal("done"),
	Type.Literal("rm"),
	Type.Literal("drop"),
	Type.Literal("append"),
	Type.Literal("view"),
]);

const TodoPhaseInputSchema = Type.Object({
	phase: Type.String({ description: "Phase name" }),
	items: Type.Array(Type.String({ description: "Task content" }), {
		description: "Tasks for this phase",
		minItems: 1,
	}),
});

export const TODO_PARAMS_SCHEMA = Type.Object({
	op: TodoOperationSchema,
	list: Type.Optional(Type.Array(TodoPhaseInputSchema, { description: "Phased task list for init" })),
	task: Type.Optional(Type.String({ description: "Task content" })),
	phase: Type.Optional(Type.String({ description: "Phase name" })),
	// Keep this unconstrained at the schema boundary. init and append return
	// operation-specific errors, while unrelated operations may ignore it.
	items: Type.Optional(Type.Array(Type.String({ description: "Task content" }), { description: "Tasks to append" })),
});

type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;

type TodoAccessors = {
	getCurrentPhases: () => TodoPhase[];
	setCurrentPhases: (phases: TodoPhase[]) => void;
	syncWidget: (ctx: ExtensionContext) => void;
};

type TodoToolResult = AgentToolResult<TodoToolDetails> & {
	isError?: boolean;
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

function formatTaskLine(task: TodoPhase["tasks"][number], theme: Theme): string {
	const content = sanitizeTodoText(task.content);
	const line = `${getTodoMarker(task.status)} ${content}`;
	switch (task.status) {
		case "completed":
			return theme.fg("dim", theme.strikethrough(line));
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
	if (args.op === "init") {
		for (const phase of phases) touched.add(phase.name);
	} else {
		if (args.phase) {
			const phase = phases.find((candidate) => candidate.name === args.phase);
			if (phase) touched.add(phase.name);
		}
		if (args.task) {
			const hit = findTaskByContent([...phases], args.task);
			if (hit) touched.add(hit.phase.name);
		}
	}
	return touched.size > 0 ? touched : null;
}

function renderTodoPhases(
	phases: readonly TodoPhase[],
	completedTasks: readonly TodoCompletionTransition[],
	options: ToolRenderResultOptions,
	args: TodoParams,
	theme: Theme,
): string {
	const visiblePhases = phases.filter((phase) => phase.tasks.length > 0);
	if (visiblePhases.length === 0) return "";

	const touched =
		options.expanded || visiblePhases.length === 1 ? null : computeTouchedPhases(args, visiblePhases, completedTasks);
	const lines: string[] = [];
	for (let index = 0; index < visiblePhases.length; index += 1) {
		const phase = visiblePhases[index];
		const oneBasedIndex = index + 1;
		if (touched && !touched.has(phase.name)) {
			lines.push(formatPhaseSummary(phase, oneBasedIndex, theme));
			continue;
		}
		lines.push(formatPhaseHeader(phase.name, oneBasedIndex, theme));
		for (const task of phase.tasks) lines.push(`  ${formatTaskLine(task, theme)}`);
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<TodoToolResult> {
			const previousPhases = clonePhases(accessors.getCurrentPhases());
			const readOnly = params.op === "view";
			const applied = readOnly
				? { phases: previousPhases, errors: [] as string[] }
				: applyParams(clonePhases(previousPhases), params);
			const failed = applied.errors.length > 0;
			const effective = failed ? previousPhases : applied.phases;
			const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, applied.phases);
			if (!readOnly && !failed) {
				pi.appendEntry(TODO_STATE_ENTRY_TYPE, {
					schema: "v2",
					phases: clonePhases(applied.phases),
				} satisfies TodoStateEntry);
				accessors.setCurrentPhases(clonePhases(applied.phases));
				accessors.syncWidget(ctx);
			}

			const details: TodoToolDetails = {
				op: params.op,
				phases: clonePhases(effective),
				storage: ctx.sessionManager.getSessionFile() ? "session" : "memory",
			};
			if (completedTasks.length > 0) details.completedTasks = completedTasks;

			return {
				content: [{ type: "text", text: formatSummary(effective, applied.errors, readOnly) }],
				details,
				isError: failed ? true : undefined,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(renderCallLabel(args))), 0, 0);
		},
		renderResult(result, options, theme, context: ToolRenderContext<unknown, TodoParams>) {
			if (isTodoToolError(result) || context.isError) {
				return new Text(theme.fg("toolOutput", getTextContent(result)), 0, 0);
			}
			const phases = result.details?.phases ?? [];
			const rendered = renderTodoPhases(phases, result.details?.completedTasks ?? [], options, context.args, theme);
			const text = rendered || getTextContent(result) || "Todo list is empty.";
			return new Text(text, 0, 0);
		},
	};

	pi.registerTool(tool);
}

function isTodoToolError(result: AgentToolResult<TodoToolDetails>): result is TodoToolResult {
	return "isError" in result && result.isError === true;
}
