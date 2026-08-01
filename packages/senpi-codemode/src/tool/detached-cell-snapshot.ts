import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { EvalDetachedCellSnapshot, EvalDetachedCellState } from "./detached-cell-manager.ts";
import { resultForDetachedState } from "./detached-eval-result.ts";
import type { EvalKernel, EvalToolDetails, EvalToolInput } from "./types.ts";

export interface DetachedCellResultSource {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly startedAtMs: number;
	state: EvalDetachedCellState;
	kernel: EvalKernel | undefined;
	stateRetained: boolean | undefined;
	liveResult: (() => AgentToolResult<EvalToolDetails>) | undefined;
	terminalResult: AgentToolResult<EvalToolDetails> | undefined;
}

export function snapshotDetachedCell(cell: DetachedCellResultSource, nowMs: number): EvalDetachedCellSnapshot {
	const durationMs = Math.max(0, nowMs - cell.startedAtMs);
	const result = resultForDetachedState(currentDetachedResult(cell), cell.state, durationMs);
	return {
		cellId: cell.cellId,
		language: cell.input.language,
		state: cell.state,
		outputTail: detachedOutputTail(result),
		result,
		stateRetained: cell.stateRetained,
	};
}

export function currentDetachedResult(cell: DetachedCellResultSource): AgentToolResult<EvalToolDetails> {
	return cell.terminalResult ?? cell.liveResult?.() ?? fallbackResult(cell.input);
}

export function detachedErrorResult(cell: DetachedCellResultSource, error: Error): AgentToolResult<EvalToolDetails> {
	const current = currentDetachedResult(cell);
	const output = detachedOutputTail(current);
	return {
		content: [
			{
				type: "text",
				text: output.length > 0 ? `${output}\n${error.message}` : error.message,
			},
			...current.content.filter((part) => part.type === "image"),
		],
		details: { ...current.details, isError: true },
	};
}

function fallbackResult(input: EvalToolInput): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: "(no output)" }],
		details: {
			language: input.language,
			languages: [input.language],
			...(input.title === undefined ? {} : { title: input.title }),
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					...(input.title === undefined ? {} : { title: input.title }),
					code: input.code,
					language: input.language,
					output: "",
					status: "running",
					durationMs: 0,
				},
			],
		},
	};
}

function detachedOutputTail(result: AgentToolResult<EvalToolDetails>): string {
	const cellOutput = result.details.cells?.[0]?.output;
	if (cellOutput !== undefined) return cellOutput;
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
