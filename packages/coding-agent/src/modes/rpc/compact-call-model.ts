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
	/**
	 * #5348 (RULING-123 C3.4): present while another call of this call's own message holds the same `toolCallId`. The
	 * per-id records that move a call (execution, hook, carrier) name only the `toolCallId`, so the reducer picked one
	 * of those calls by order: the call itself and its announcement are exact, but its phase, start, hook, progress,
	 * result, outcome, carrier and nested calls may belong to the other one. Absent on every other call.
	 */
	readonly callUnknown?: true;
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
	/** The retired call's `callUnknown` mark (#5348): its outcome, carrier and nested calls were attributed by order. */
	readonly callUnknown?: true;
	/**
	 * `omitted` counts completed children a projecting path left out (RULING-49). It is 0 whenever paging is complete:
	 * the settled store pages every completed child instead of capping it (RULING-60 Q3, RULING-67 (1)), and no producer
	 * truncates. A consumer that truncates for its own bound reports its exact count here and carries RULING-49's
	 * exact-count test. `complete` is false when a child is still open, incomplete, or omitted.
	 */
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

/** The header fields a new call starts from before its creating record fills its own. */
export const FRESH_CALL = {
	owningMessageId: null,
	contentIndex: null,
	parentKey: null,
	join: "pending",
	startSequence: null,
	startedAtMs: null,
	requestedName: null,
	resolvedName: null,
	seed: null,
	raw: null,
	input: { announced: null, started: null, prepared: null },
	correlation: null,
	hook: null,
	progress: null,
	result: null,
	outcome: null,
} as const;

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

/**
 * RULING-123 (#5346): the call a compact peer's copy of a live call record names. `runtimeItemKey` is the key the
 * outstanding call the record changed was created with, the key that call's snapshot `calls` entry, its settled
 * projection and the session file carry: the producer's block or bridge key (`core/session-call-keys.ts`, RULING-127),
 * or `runtimeItemKey` above for a call with no backing block. Opaque, fixed for the call's lifetime, and never reused in
 * the session, so it alone is unique, even when providers reuse a `toolCallId`.
 * `callUnknown`: the host changed no call with this record, so it cannot vouch for one (RULING-122's fail-safe rule).
 * The snapshot rows of calls sharing a `toolCallId` inside their message carry it too (`OutstandingCall.callUnknown`).
 */
export type CallIdentity = { readonly runtimeItemKey: string } | { readonly callUnknown: true };

export const CALL_UNKNOWN: CallIdentity = Object.freeze({ callUnknown: true });

export function callIdentity(call: OutstandingCall | undefined): CallIdentity {
	return call ? { runtimeItemKey: call.runtimeItemKey } : CALL_UNKNOWN;
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
