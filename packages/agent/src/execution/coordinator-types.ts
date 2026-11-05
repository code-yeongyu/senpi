import type { StoreValue } from "../durable/store.ts";
import type { ExecutionOutcome } from "./ledger-types.ts";

/** One model call of an assistant message, in source order, as the brain plans it. */
export type BatchCallPlan = {
	readonly executionId: string;
	readonly executor: string;
	readonly name: string;
	readonly args: StoreValue;
	/** The tool's `executionMode` is `"sequential"`, the same test today's scheduler applies. */
	readonly sequential: boolean;
};

export type BatchPlan = {
	readonly batchId: string;
	readonly scope: string;
	readonly workspace: string;
	readonly generation: number;
	readonly admittedAt: number;
	readonly leaseUntil: number;
	readonly calls: readonly BatchCallPlan[];
};

export type ManifestCall = BatchCallPlan & {
	readonly sourceIndex: number;
	/** Source indexes this call waits for before its release, computed as today's scheduler computes them. */
	readonly dependsOn: readonly number[];
	readonly wave: number;
	readonly requestDigest: string;
};

export type BatchManifest = Omit<BatchPlan, "calls"> & {
	readonly issuer: string;
	readonly manifestDigest: string;
	readonly calls: readonly ManifestCall[];
};

export type PrepareRequest = {
	readonly issuer: string;
	readonly executionId: string;
	readonly generation: number;
	readonly batchId: string;
	readonly manifestDigest: string;
	readonly scope: string;
	readonly workspace: string;
	readonly admittedAt: number;
	readonly leaseUntil: number;
	readonly requestDigest: string;
	readonly call: { readonly name: string; readonly args: StoreValue };
	/** Gate A approved this raw request digest (design 5.6.1); the executor asks again only for a different frozen call. */
	readonly authorizedDigest?: string;
};

export type ExecutionRef = { readonly issuer: string; readonly executionId: string; readonly generation: number };

/**
 * The executor's durable answer to a prepare. A re-sent prepare returns the stored answer and never reruns
 * preparation; a call whose endpoint already ended (for example `hand_restarted` after an executor restart during
 * preparation) answers `settled` with that terminal outcome. A preparation the executor stopped itself is answered as
 * `blocked` or `batch_abort`, also on a re-send, never as the raw `settled` ledger outcome: the ledger stores both
 * under reason `blocked`, and only the executor can tell a blocked call from a preflight abort.
 */
export type PrepareReply =
	| { readonly kind: "prepared"; readonly frozenDigest: string }
	/** Gate B: the frozen call differs from what Gate A authorized and needs consent; the approval binds this digest. */
	| { readonly kind: "prepared_awaiting_consent"; readonly frozenDigest: string }
	| { readonly kind: "blocked"; readonly result: StoreValue }
	| { readonly kind: "batch_abort" }
	| { readonly kind: "settled"; readonly outcome: ExecutionOutcome };

/** Release and abort answer with the endpoint's terminal outcome; an executor that lost the call says so. */
export type SettleReply =
	| { readonly kind: "settled"; readonly outcome: ExecutionOutcome }
	| { readonly kind: "unknown_execution" };

/** The hand side of the batch protocol. Every method is replay-safe: re-sending gives the same effect. */
export interface BatchExecutor {
	prepare(request: PrepareRequest): Promise<PrepareReply>;
	/** Resolves once the released call has settled. */
	release(ref: ExecutionRef): Promise<SettleReply>;
	abort(ref: ExecutionRef): Promise<SettleReply>;
	/**
	 * Applies an approval to a call awaiting consent on `frozenDigest`: `prepared`, or the call's terminal outcome (a
	 * lease that expired while it waited rejects the approval). Only cross-machine executors gate consent.
	 */
	consent?(ref: ExecutionRef, frozenDigest: string): Promise<{ readonly kind: "prepared" } | SettleReply>;
}

/** What an approver answered; `expired` is the call's lease running out first. */
export type ConsentAnswer = "approved" | "denied" | "expired";

export type ConsentRequest = ExecutionRef & {
	readonly gate: "raw" | "frozen";
	readonly digest: string;
	readonly name: string;
	readonly leaseUntil: number;
};

/**
 * Consent for cross-machine executions (design 5.6.1 Gate A and Gate B). Any RPC-authorized party may answer through
 * `approve`; the device is not the only approver (K2). Fused and split-local sessions configure none (K3).
 */
export interface BatchConsent {
	/**
	 * Gate A: the engine's built-in permission classification of the raw call, before any extension callback. A call that
	 * classifies as denied is not consent: it is prepared and the hand's own `tool_call` chain refuses it, as today.
	 */
	needsConsent(call: { readonly name: string; readonly args: StoreValue }): boolean;
	approve(request: ConsentRequest): Promise<ConsentAnswer>;
}

/** One answered consent of a call, durable before the step it decides. */
export type ConsentRecord = {
	readonly gate: "raw" | "frozen";
	readonly digest: string;
	readonly answer: ConsentAnswer;
};

export type BatchDecision = "RELEASE" | "ABORT";

export type CallOutcome =
	| { readonly kind: "result"; readonly value: StoreValue }
	| { readonly kind: "blocked"; readonly result: StoreValue }
	/** The body never ran: the batch was aborted before this call was released. */
	| { readonly kind: "not_run"; readonly cause: "batch_abort" | "interrupted_preparation" }
	| {
			readonly kind: "interrupted";
			readonly reason: Exclude<ExecutionOutcome["reason"], "result" | "blocked"> | "unknown_execution";
			readonly uncertain: boolean;
	  };

/** The coordinator's durable record of one batch; every field is written before the message it causes is sent. */
export type BatchRecord = {
	readonly manifest: BatchManifest;
	readonly prepares: readonly (PrepareReply | null)[];
	readonly decision: BatchDecision | null;
	readonly released: readonly boolean[];
	readonly outcomes: readonly (CallOutcome | null)[];
	/** Answered consents per call; absent on a record written before consent gating. */
	readonly consents?: readonly (ConsentRecord | null)[];
};

export type BatchResult = {
	readonly decision: BatchDecision;
	readonly outcomes: readonly CallOutcome[];
};
