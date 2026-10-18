/**
 * Closed types of the one pending-input lifecycle (senpi#3549). A pending input is admitted into durable custody
 * and ends delivered, removed, or failed; `edited` and `superseded` are facts of the same record, never a second
 * runnable input. Only `reducePendingInput` changes a `PendingInput`; every surface renders `projectPendingInput`.
 */

export type PendingInputPhase = "queued" | "sending" | "delivered" | "removed" | "failed";

export type PendingInputMode = "steer" | "followUp";

/** Whether a failed input can be resent: `not_delivered` is proven safe, `uncertain` is not. */
export type DeliveryCertainty = "not_delivered" | "uncertain";

/** Why an input was retired by removal; an explicit user or owner action every time. */
export type RemovalCause = "remove" | "stop" | "child_cancel";

/** How delivery was proven: a committed user entry with this identity, or a durable handled-command receipt. */
export type DeliveryWitness = "consumed" | "handled";

/** The current, lifetime-scoped handle of an input. A reopen issues a new one; revision restarts at 1. */
export interface PendingInputHandle {
	readonly lifetimeId: string;
	readonly queuedId: string;
}

/** The reservation a consumer holds while it hands one input off; a stale token cannot change state. */
export interface DeliveryToken {
	readonly ownerId: string;
	readonly writerGeneration: number;
	readonly lifetimeId: string;
	readonly attemptId: string;
	readonly clientMessageId: string;
}

/** A retired content version: an acknowledged edit replaced it, and it is never runnable again. */
export interface SupersededVersion {
	/** The lifetime that revision belongs to; revisions restart at 1 on reopen. */
	readonly lifetimeId: string;
	readonly revision: number;
	readonly text: string;
}

export interface PendingInputFailure {
	readonly delivery: DeliveryCertainty;
	readonly reason: string;
}

/** The recorded answer of one operation, replayed byte for byte when the same effect id repeats. */
export interface RecordedOperation {
	readonly fingerprint: string;
	readonly result: PendingInputOperationResult;
}

export interface PendingInput {
	/** Durable key with the session: survives reopen; never a queue id, text, or order. */
	readonly clientMessageId: string;
	/** Fingerprint of the original submission; a reused id with another payload is refused. */
	readonly fingerprint: string;
	readonly handle: PendingInputHandle;
	/** 1 at admission, +1 only after a successful edit. */
	readonly revision: number;
	/** Survives reopen, unlike the revision. */
	readonly hasEdits: boolean;
	readonly text: string;
	readonly attachments: readonly string[];
	readonly requestedMode: PendingInputMode;
	readonly phase: PendingInputPhase;
	readonly failure?: PendingInputFailure;
	readonly removedBy?: RemovalCause;
	readonly deliveredBy?: DeliveryWitness;
	/** The live reservation while `sending`; absent in every other phase. */
	readonly attempt?: DeliveryToken;
	readonly attemptCount: number;
	readonly superseded: readonly SupersededVersion[];
	readonly operations: Readonly<Record<string, RecordedOperation>>;
}

export interface SubmitEvent {
	readonly type: "submit";
	readonly clientMessageId: string;
	readonly fingerprint: string;
	readonly handle: PendingInputHandle;
	readonly text: string;
	readonly attachments: readonly string[];
	readonly requestedMode: PendingInputMode;
}

/** A mutation names the handle and revision it was based on, and carries an effect id for replay. */
export interface MutationTarget {
	readonly effectId: string;
	readonly handle: PendingInputHandle;
	readonly expectedRevision: number;
}

export type PendingInputEvent =
	| SubmitEvent
	| { readonly type: "reject_before_dispatch"; readonly reason: string }
	| ({ readonly type: "edit"; readonly text: string; readonly attachments: readonly string[] } & MutationTarget)
	| ({ readonly type: "remove" } & MutationTarget)
	| { readonly type: "retry"; readonly effectId: string; readonly handle: PendingInputHandle }
	| { readonly type: "reserve"; readonly token: DeliveryToken }
	| { readonly type: "consumed"; readonly token: DeliveryToken }
	| { readonly type: "handled"; readonly token?: DeliveryToken }
	| { readonly type: "refused"; readonly token: DeliveryToken; readonly reason: string }
	| { readonly type: "ambiguous"; readonly token: DeliveryToken; readonly reason: string }
	/** An identity-bearing delivery witness found after the fact (a late event or recovery). */
	| { readonly type: "witnessed" }
	/** Complete, fenced evidence that no consumer can still deliver the attempt. */
	| { readonly type: "non_delivery_proven" }
	/** Teardown that is not an explicit user action: reload, unload, crash, handoff. */
	| { readonly type: "teardown" }
	| { readonly type: "owner_lost"; readonly token: DeliveryToken }
	/** An explicit Stop or child cancellation; `consumerFenced` proves an in-flight attempt was not consumed. */
	| { readonly type: "cancel"; readonly cause: "stop" | "child_cancel"; readonly consumerFenced: boolean }
	| { readonly type: "rebind"; readonly handle: PendingInputHandle };

export type OperationOutcome =
	| "admitted"
	| "replayed"
	| "client_message_id_conflict"
	| "edited"
	| "removed"
	| "requeued"
	| "already_delivered"
	| "not_found"
	| "conflict"
	| "sending"
	| "not_retryable"
	| "not_editable"
	| "unresolved"
	| "effect_id_conflict"
	| "stale_handle";

export interface PendingInputOperationResult {
	readonly outcome: OperationOutcome;
	readonly clientMessageId: string;
	readonly revision?: number;
	readonly currentRevision?: number;
	readonly text?: string;
	/** The lifetime this answer was recorded in; a replay names its original lifetime, not the current one. */
	readonly lifetimeId?: string;
	readonly replayed?: boolean;
}

/** What the store must do after committing `next`; the reducer itself never performs I/O. */
export type PendingInputEffect =
	| { readonly type: "persist" }
	| { readonly type: "dispatch"; readonly token: DeliveryToken }
	| { readonly type: "restore_to_draft"; readonly text: string };

export interface PendingInputDecision {
	readonly next: PendingInput | undefined;
	readonly result?: PendingInputOperationResult;
	readonly effects: readonly PendingInputEffect[];
}
