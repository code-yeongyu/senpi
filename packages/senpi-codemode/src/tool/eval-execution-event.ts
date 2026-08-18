import type { AgentToolResult } from "@code-yeongyu/senpi";
import {
	capCodePoints,
	MAX_AGGREGATED_TOOL_NAMES,
	MAX_CAPTURED_IDENTIFIER_CODE_POINTS,
	MAX_ENRICHED_TOOL_CALLS,
	MAX_RPC_EVENT_BYTES,
} from "./call-capture.ts";
import type { CellState } from "./cell-runtime.ts";
import type { EvalLanguage, EvalToolCallSummary, EvalToolDetails } from "./types.ts";

export const EVAL_EXECUTION_EVENT = "senpi.eval.execution";

export interface EvalToolAggregate {
	readonly count: number;
	readonly totalDurationMs: number;
	readonly okCount: number;
	readonly errorCount: number;
	readonly pendingCount: number;
}

export type EvalToolAggregates = Record<string, EvalToolAggregate>;

interface EvalExecutionBasePayload {
	readonly version: 1;
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly ok: boolean;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly durationMs: number;
	readonly kernelDurationMs?: number;
	readonly detached: boolean;
	readonly toolCallCount: number;
	readonly pendingToolCallCount: number;
	readonly distinctToolsCalled: readonly string[];
	readonly toolAggregates: EvalToolAggregates;
	readonly toolAggregatesTruncated: boolean;
	readonly toolAggregateOverflow?: EvalToolAggregate;
}

export interface EvalExecutionEventPayload extends EvalExecutionBasePayload {
	readonly detailLevel: "full";
	readonly error?: string;
	readonly toolCalls: readonly EvalToolCallSummary[];
}

export interface EvalExecutionRpcToolCallSummary {
	readonly name: string;
	readonly ok: boolean;
	readonly durationMs?: number;
}

export interface EvalExecutionRpcPayload extends EvalExecutionBasePayload {
	readonly detailLevel: "metadata";
	readonly rpcTruncated: boolean;
	readonly toolCalls: readonly EvalExecutionRpcToolCallSummary[];
}

export type EvalExecutionSettleOutcome =
	| { readonly result: AgentToolResult<EvalToolDetails> }
	| { readonly error: unknown };

export interface BuildEvalExecutionEventPayloadOptions {
	readonly cellId: string;
	readonly state: CellState;
	readonly outcome: EvalExecutionSettleOutcome;
	readonly completedAt: number;
	readonly detached: boolean;
}

export function buildEvalExecutionEventPayload(
	options: BuildEvalExecutionEventPayloadOptions,
): EvalExecutionEventPayload {
	const { cellId, state, outcome, completedAt, detached } = options;
	const result = "result" in outcome ? outcome.result : undefined;
	const ok = result?.details.isError !== true && !("error" in outcome);
	const aggregateState = aggregateToolCalls(state, completedAt);
	const error = ok ? undefined : settleError(state, outcome);
	return {
		version: 1,
		detailLevel: "full",
		cellId: capCodePoints(cellId, MAX_CAPTURED_IDENTIFIER_CODE_POINTS),
		language: state.input.language,
		ok,
		...(error === undefined ? {} : { error: capCodePoints(error, 512) }),
		startedAt: state.startedAt,
		completedAt,
		durationMs: Math.max(0, completedAt - state.startedAt),
		...(result === undefined ? {} : { kernelDurationMs: result.details.durationMs }),
		detached,
		toolCallCount: state.toolCallMetrics.length,
		pendingToolCallCount: aggregateState.pendingCount,
		toolCalls: state.toolCalls.slice(0, MAX_ENRICHED_TOOL_CALLS),
		distinctToolsCalled: [...aggregateState.aggregates.keys()],
		toolAggregates: Object.fromEntries(aggregateState.aggregates),
		toolAggregatesTruncated: aggregateState.overflow !== undefined,
		...(aggregateState.overflow === undefined ? {} : { toolAggregateOverflow: aggregateState.overflow }),
	};
}

export function toEvalExecutionRpcPayload(payload: EvalExecutionEventPayload): EvalExecutionRpcPayload {
	const candidate: EvalExecutionRpcPayload = {
		version: payload.version,
		detailLevel: "metadata",
		rpcTruncated: false,
		cellId: payload.cellId,
		language: payload.language,
		ok: payload.ok,
		startedAt: payload.startedAt,
		completedAt: payload.completedAt,
		durationMs: payload.durationMs,
		...(payload.kernelDurationMs === undefined ? {} : { kernelDurationMs: payload.kernelDurationMs }),
		detached: payload.detached,
		toolCallCount: payload.toolCallCount,
		pendingToolCallCount: payload.pendingToolCallCount,
		toolCalls: payload.toolCalls.map((call) => ({
			name: call.name,
			ok: call.ok,
			...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
		})),
		distinctToolsCalled: payload.distinctToolsCalled,
		toolAggregates: payload.toolAggregates,
		toolAggregatesTruncated: payload.toolAggregatesTruncated,
		...(payload.toolAggregateOverflow === undefined ? {} : { toolAggregateOverflow: payload.toolAggregateOverflow }),
	};
	if (serializedBytes(candidate) <= MAX_RPC_EVENT_BYTES) return candidate;
	return {
		...candidate,
		rpcTruncated: true,
		toolCalls: [],
		distinctToolsCalled: [],
		toolAggregates: {},
		toolAggregatesTruncated: true,
		toolAggregateOverflow: totalAggregate(payload),
	};
}

function aggregateToolCalls(
	state: CellState,
	completedAt: number,
): {
	readonly aggregates: Map<string, EvalToolAggregate>;
	readonly overflow: EvalToolAggregate | undefined;
	readonly pendingCount: number;
} {
	const aggregates = new Map<string, EvalToolAggregate>();
	let overflow: EvalToolAggregate | undefined;
	let pendingCount = 0;
	for (const metric of state.toolCallMetrics) {
		const item: EvalToolAggregate = {
			count: 1,
			totalDurationMs: metric.durationMs ?? Math.max(0, completedAt - metric.startedAt),
			okCount: metric.ok === true ? 1 : 0,
			errorCount: metric.ok === false ? 1 : 0,
			pendingCount: metric.ok === undefined ? 1 : 0,
		};
		pendingCount += item.pendingCount;
		const existing = aggregates.get(metric.name);
		if (existing !== undefined) {
			aggregates.set(metric.name, addAggregate(existing, item));
			continue;
		}
		if (aggregates.size < MAX_AGGREGATED_TOOL_NAMES) {
			aggregates.set(metric.name, item);
			continue;
		}
		overflow = overflow === undefined ? item : addAggregate(overflow, item);
	}
	return { aggregates, overflow, pendingCount };
}

function addAggregate(left: EvalToolAggregate, right: EvalToolAggregate): EvalToolAggregate {
	return {
		count: left.count + right.count,
		totalDurationMs: left.totalDurationMs + right.totalDurationMs,
		okCount: left.okCount + right.okCount,
		errorCount: left.errorCount + right.errorCount,
		pendingCount: left.pendingCount + right.pendingCount,
	};
}

function totalAggregate(payload: EvalExecutionEventPayload): EvalToolAggregate {
	let total: EvalToolAggregate = { count: 0, totalDurationMs: 0, okCount: 0, errorCount: 0, pendingCount: 0 };
	for (const aggregate of Object.values(payload.toolAggregates)) total = addAggregate(total, aggregate);
	if (payload.toolAggregateOverflow !== undefined) total = addAggregate(total, payload.toolAggregateOverflow);
	return total;
}

function serializedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function settleError(state: CellState, outcome: EvalExecutionSettleOutcome): string | undefined {
	if (state.error !== undefined) return state.error;
	if ("error" in outcome) return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
	for (const part of outcome.result.content) {
		if (part.type === "text" && part.text.length > 0) return part.text.trimEnd();
	}
	return undefined;
}
