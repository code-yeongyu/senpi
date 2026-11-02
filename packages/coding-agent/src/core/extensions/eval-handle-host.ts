/**
 * Host capability that lets an eval cell wait on, inspect and control work the host owns (agent runs,
 * workpools). The task owner implements it and registers it; codemode only consumes it. Every operation is
 * fenced by the owning session, the handle id and its run epoch: a ref whose epoch is no longer live is
 * refused with `eval_handle_stale`, never silently redirected to a successor run.
 */

export type HandleKind = "agent" | "completion" | "workpool";

export interface HandleRef {
	readonly kind: HandleKind;
	readonly id: string;
	readonly run_epoch: number;
}

export type HandlePhase = "pending" | "succeeded" | "failed" | "cancelled" | "lost";

export interface HandleSnapshot {
	readonly ref: HandleRef;
	readonly phase: HandlePhase;
	readonly host_status: string;
	/** Strictly increases with every change of this ref; a consumer drops an update whose revision is not newer. */
	readonly revision: number;
}

export interface HandleError {
	readonly code: string;
	readonly message: string;
	readonly details?: unknown;
}

export type HandleOutcome =
	| { readonly status: "fulfilled"; readonly ref: HandleRef; readonly value: unknown }
	| { readonly status: "rejected"; readonly ref: HandleRef; readonly error: HandleError };

export interface HandleCallContext {
	readonly ownerSessionId: string;
	readonly signal?: AbortSignal;
}

export interface HandleWatch {
	/** One snapshot per watched ref, taken atomically with the subscription. */
	readonly initial: readonly HandleSnapshot[];
	/** Every change after `initial`, in order; a change during `watch()` setup arrives here exactly once. */
	readonly updates: AsyncIterable<HandleSnapshot>;
	close(): void;
}

export interface CancelReceipt {
	readonly ref: HandleRef;
	/** False when the run had already ended; cancelling twice is not an error. */
	readonly cancelled: boolean;
	readonly phase: HandlePhase;
}

export interface OutputRequest {
	readonly format?: "raw" | "tail";
	readonly offset?: number;
	readonly limit?: number;
}

export interface OutputSnapshot {
	readonly ref: HandleRef;
	readonly text: string;
	readonly offset: number;
	readonly total: number;
	readonly truncated: boolean;
}

export interface EvalHandleHost {
	readonly version: 1;
	watch(refs: readonly HandleRef[], ctx: HandleCallContext): Promise<HandleWatch>;
	/** The terminal outcome; rejects with `eval_handle_pending` while the run is still pending. */
	result(ref: HandleRef, ctx: HandleCallContext): Promise<HandleOutcome>;
	/** Agent refs only; others refuse with `eval_handle_operation_unsupported`. */
	send(ref: HandleRef, message: string, ctx: HandleCallContext): Promise<HandleSnapshot>;
	cancel(ref: HandleRef, ctx: HandleCallContext): Promise<CancelReceipt>;
	output(ref: HandleRef, request: OutputRequest, ctx: HandleCallContext): Promise<OutputSnapshot>;
}

export const EVAL_HANDLE_ERROR_CODES = [
	"eval_handle_stale",
	"eval_handle_forbidden",
	"eval_handle_not_found",
	"eval_handle_pending",
	"eval_handle_operation_unsupported",
	"eval_wait_unavailable",
	"eval_wait_timeout",
	"eval_wait_empty",
	"eval_pool_open",
	"eval_workpool_failed",
] as const;

export type EvalHandleErrorCode = (typeof EVAL_HANDLE_ERROR_CODES)[number];

export class EvalHandleError extends Error {
	readonly name = "EvalHandleError";
	readonly code: EvalHandleErrorCode;
	readonly details?: unknown;

	constructor(code: EvalHandleErrorCode, message: string, details?: unknown) {
		super(`${code}: ${message}`);
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}
