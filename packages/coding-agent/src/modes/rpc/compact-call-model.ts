import type { LeafId } from "./compact-content-store.ts";
import type { ValueRef } from "./compact-values.ts";

export type CallPhase = "streaming" | "awaiting-execution" | "executing" | "completed-awaiting-entry";
export type CallJoin = "pending" | "carrierless";
export type CallOutcome =
	| { readonly kind: "result"; readonly isError: boolean; readonly source: "execution_end" | "result_message" }
	| { readonly kind: "not-executed" }
	| { readonly kind: "abandoned" };
export type CallRaw =
	| { readonly kind: "active"; readonly messageId: string; readonly contentIndex: number }
	| { readonly kind: "owned"; readonly root: LeafId; readonly tailRoot: LeafId };
export interface CallInput {
	readonly announced: unknown;
	readonly started: unknown;
	readonly prepared: unknown;
}
export interface CallCorrelation {
	readonly clientMessageId?: unknown;
	readonly clientTurnId?: unknown;
}

/** One outstanding call as the calls root stores it (R3.C3.2): a JSON-normal header plus refs to owned slots. */
export interface OutstandingCall {
	readonly runtimeItemKey: string;
	readonly turnId: string;
	readonly toolCallId: string | null;
	readonly owningMessageId: string | null;
	readonly contentIndex: number | null;
	readonly parentKey: string | null;
	readonly phase: CallPhase;
	readonly join: CallJoin;
	readonly startSequence: number | null;
	readonly startedAtMs: number | null;
	readonly requestedName: string | null;
	readonly resolvedName: string | null;
	readonly seed: unknown;
	readonly raw: CallRaw | null;
	readonly input: CallInput;
	readonly correlation: CallCorrelation | null;
	readonly hook: ValueRef | null;
	readonly progress: ValueRef | null;
	readonly result: ValueRef | null;
	readonly outcome: CallOutcome | null;
}

/** The persisted form a settled toolResult row carries once its call retired (R3.C3.3, RULING-13 Q2/Q5). */
export interface CallProjection {
	readonly runtimeItemKey: string;
	readonly turnId: string;
	readonly toolCallId: string | null;
	readonly owningMessageId: string | null;
	readonly contentIndex: number | null;
	readonly parentKey: string | null;
	readonly requestedName: string | null;
	readonly resolvedName: string | null;
	readonly seed: unknown;
	readonly input: CallInput;
	readonly correlation: CallCorrelation | null;
	readonly startSequence: number | null;
	readonly startedAtMs: number | null;
	readonly outcome: CallOutcome | null;
	/** `omitted` counts completed children left out at `NESTED_PROJECTION_LIMIT` (RULING-49); `complete` is false when it is not 0. */
	readonly nestedCalls: {
		readonly calls: readonly CallProjection[];
		readonly complete: boolean;
		readonly omitted: number;
	};
}

export interface CallCounters {
	readonly live: number;
	readonly carrierless: number;
	readonly replacements: number;
	readonly headerBytes: number;
	readonly slotBytes: number;
	readonly progressReplacements: number;
	readonly ignored: { readonly unknown: number; readonly late: number };
	readonly collisions: number;
	readonly reused: number;
}

export interface FrozenCalls {
	readonly sequence: number;
	readonly ref: ValueRef | undefined;
	readonly counters: CallCounters;
}

/** The lane facts a call transition consumes: the key epoch (RULING-13 Q1) and the lane-minted turn (Q6). */
export interface CallScope {
	readonly sessionEpoch: string;
	readonly turnId: string | null;
}

/** Completed children carried on a parent projection: the same bound as the parent's nested-call record. */
export const NESTED_PROJECTION_LIMIT = 256;

export const TERMINAL_PHASE: CallPhase = "completed-awaiting-entry";

/** Execution, hook and boundary records the lane folds into the calls component. */
export const CALL_RECORDS: ReadonlySet<string> = new Set([
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"tool_hook_status",
	"turn_end",
	"agent_settled",
	"message_end",
]);

/** Records whose only lane effect is a call transition: ignored, they take no sequence (RULING-13 Q9). */
export const CALL_ONLY_RECORDS: ReadonlySet<string> = new Set([
	"tool_execution_update",
	"tool_execution_end",
	"tool_hook_status",
	"agent_settled",
]);

export function runtimeItemKey(scope: CallScope, creationSequence: number, k: number): string {
	return `${scope.sessionEpoch}:${creationSequence}.${k}`;
}

/** Fixed-width tree ordinal so the root orders calls by creation, independent of the epoch string. */
export function callOrder(creationSequence: number, k: number): string {
	return `${String(creationSequence).padStart(16, "0")}.${String(k).padStart(4, "0")}`;
}

export function callLeaves(call: OutstandingCall): readonly LeafId[] {
	return [
		call.hook?.owner ?? 0,
		call.progress?.owner ?? 0,
		call.result?.owner ?? 0,
		...(call.raw?.kind === "owned" ? [call.raw.root, call.raw.tailRoot] : []),
	];
}

export function terminal(call: OutstandingCall): boolean {
	return call.phase === TERMINAL_PHASE;
}
