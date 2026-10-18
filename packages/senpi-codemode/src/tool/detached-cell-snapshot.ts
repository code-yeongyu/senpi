import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { EvalDetachedCellSnapshot, EvalDetachedCellState } from "./detached-cell-manager.ts";
import { resultForDetachedState } from "./detached-eval-result.ts";
import { EvalKernelResetRefusedError } from "./eval-kernel-reset-refused-error.ts";
import type { EvalKernel, EvalToolDetails, EvalToolInput } from "./types.ts";

export interface DetachedCellResultSource {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly startedAtMs: number;
	readonly runStartedAtMs?: number | undefined;
	readonly detached?: boolean;
	state: EvalDetachedCellState;
	kernel: EvalKernel | undefined;
	stateRetained: boolean | undefined;
	interruptNote?: string | undefined;
	liveResult: (() => AgentToolResult<EvalToolDetails>) | undefined;
	terminalResult: AgentToolResult<EvalToolDetails> | undefined;
	hardLimited?: boolean;
	hardLimitSeconds?: number;
	runBudgetExhausted?: boolean;
	runBudgetSeconds?: number;
}

export function snapshotDetachedCell(cell: DetachedCellResultSource, nowMs: number): EvalDetachedCellSnapshot {
	const durationMs = cell.runStartedAtMs === undefined ? 0 : Math.max(0, nowMs - cell.runStartedAtMs);
	const state = cell.detached && (cell.state === "queued" || cell.state === "running") ? "detached" : cell.state;
	const queuedBehind = queuedBehindCell(cell);
	const result = resultForDetachedState(currentDetachedResult(cell), state, durationMs, queuedBehind);
	return {
		cellId: cell.cellId,
		language: cell.input.language,
		startedAtMs: cell.startedAtMs,
		state,
		...(queuedBehind === undefined ? {} : { queuedBehind }),
		outputTail: detachedOutputTail(result),
		result,
		stateRetained: cell.stateRetained,
		...(cell.interruptNote === undefined ? {} : { interruptNote: cell.interruptNote }),
		...(cell.hardLimited === true && cell.hardLimitSeconds !== undefined
			? { hardLimitSeconds: cell.hardLimitSeconds }
			: {}),
		...(cell.runBudgetExhausted === true && cell.runBudgetSeconds !== undefined
			? { runBudgetSeconds: cell.runBudgetSeconds }
			: {}),
	};
}

export function queuedBehindCell(
	cell: Pick<DetachedCellResultSource, "state" | "kernel" | "cellId">,
): readonly string[] | undefined {
	if (cell.state !== "queued") return undefined;
	const queue = cell.kernel?.queueSnapshot();
	if (queue === undefined) return [];
	const index = queue.queuedCellIds.indexOf(cell.cellId);
	return [
		...(queue.activeCellId === null || queue.activeCellId === cell.cellId ? [] : [queue.activeCellId]),
		...queue.queuedCellIds.slice(0, index < 0 ? undefined : index),
	];
}

export function currentDetachedResult(cell: DetachedCellResultSource): AgentToolResult<EvalToolDetails> {
	return cell.terminalResult ?? cell.liveResult?.() ?? fallbackResult(cell.input);
}

/**
 * The result a cell cancelled before its handler finished settles with: its buffered output, not the live progress
 * frame ("1/1 cells running"), so a stopped cell never reads as still running.
 */
export function cancelledDetachedResult(cell: DetachedCellResultSource): AgentToolResult<EvalToolDetails> {
	if (cell.terminalResult !== undefined) return cell.terminalResult;
	const current = currentDetachedResult(cell);
	const output = detachedOutputTail(current);
	return {
		content: [
			{ type: "text", text: output.length > 0 ? output : "(no output)" },
			...current.content.filter((part) => part.type === "image"),
		],
		details: current.details,
	};
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
		details: {
			...current.details,
			isError: true,
			...(error instanceof EvalKernelResetRefusedError ? { code: error.code } : {}),
		},
	};
}

function fallbackResult(input: EvalToolInput): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: "(no output)" }],
		details: {
			language: input.language,
			languages: [input.language],
			...(input.summary === undefined ? {} : { summary: input.summary }),
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					...(input.summary === undefined ? {} : { summary: input.summary }),
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
