import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi";
import { type Static, Type } from "typebox";
import type { CodeModeCellState, CodeModeObservation, CodeModeSessionRuntime } from "./runtime.ts";

const DEFAULT_YIELD_TIME_MS = 10_000;

const execInputSchema = Type.Object({
	code: Type.String({ minLength: 1, description: "JavaScript program to execute in a dedicated Code Mode cell." }),
	yield_time_ms: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 60_000, description: "Return a yielded cell after this many milliseconds." }),
	),
});

const waitInputSchema = Type.Object({
	cell_id: Type.String({ minLength: 1, description: "Code Mode cell id returned by exec." }),
	yield_time_ms: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 60_000, description: "Return again after this many milliseconds." }),
	),
	terminate: Type.Optional(Type.Boolean({ description: "Interrupt and close the cell instead of waiting." })),
});

type ExecInput = Static<typeof execInputSchema>;
type WaitInput = Static<typeof waitInputSchema>;

export interface CodeModeToolDetails {
	readonly cellId: string;
	readonly state: CodeModeCellState;
	readonly isError?: boolean;
}

export type CodeModeTool =
	| ToolDefinition<typeof execInputSchema, CodeModeToolDetails>
	| ToolDefinition<typeof waitInputSchema, CodeModeToolDetails>;

export interface CreateCodeModeToolsOptions {
	readonly runtime: CodeModeSessionRuntime;
}

export function createCodeModeTools(options: CreateCodeModeToolsOptions): {
	readonly exec: ToolDefinition<typeof execInputSchema, CodeModeToolDetails>;
	readonly wait: ToolDefinition<typeof waitInputSchema, CodeModeToolDetails>;
} {
	return {
		exec: {
			name: "exec",
			label: "GPT Code Mode Exec",
			description:
				"Run JavaScript in a dedicated GPT Code Mode cell. Call active Senpi tools as `tools.<name>(args)`. " +
				"If the cell yields, call wait with its cell_id.",
			promptSnippet: "Execute JavaScript that composes active tools in a dedicated Code Mode cell.",
			promptGuidelines: [
				"Use exec for bounded JavaScript composition of active tools; use eval for persistent multi-language analysis.",
				"Call wait only when exec reports a yielded cell, and terminate abandoned cells with wait({ cell_id, terminate: true }).",
			],
			parameters: execInputSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params: ExecInput, signal) {
				return resultFrom(
					await options.runtime.execute(params.code, params.yield_time_ms ?? DEFAULT_YIELD_TIME_MS, signal),
				);
			},
		},
		wait: {
			name: "wait",
			label: "GPT Code Mode Wait",
			description: "Observe a yielded GPT Code Mode cell or terminate it.",
			promptSnippet: "Wait for, or terminate, a yielded GPT Code Mode cell.",
			parameters: waitInputSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params: WaitInput, signal) {
				return resultFrom(
					await options.runtime.wait(
						params.cell_id,
						params.yield_time_ms ?? DEFAULT_YIELD_TIME_MS,
						params.terminate ?? false,
						signal,
					),
				);
			},
		},
	};
}

function resultFrom(observation: CodeModeObservation): AgentToolResult<CodeModeToolDetails> {
	const text =
		observation.output ||
		(observation.state === "yielded"
			? `Code Mode cell ${observation.cellId} is still running. Call wait with this cell_id.`
			: observation.state === "missing"
				? `Code Mode cell ${observation.cellId} does not exist.`
				: observation.state === "terminated"
					? `Code Mode cell ${observation.cellId} was terminated.`
					: (observation.error ?? `Code Mode cell ${observation.cellId} completed.`));
	return {
		content: [{ type: "text", text }],
		details: {
			cellId: observation.cellId,
			state: observation.state,
			...(observation.state === "error" || observation.state === "missing" ? { isError: true } : {}),
		},
	};
}

export function isGptCodeModeModel(modelId: string | undefined): boolean {
	return modelId !== undefined && /(^|[/.:])gpt[-.]/iu.test(modelId);
}
