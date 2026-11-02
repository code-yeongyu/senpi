import type { StoreValue } from "../durable/store.ts";

export type ExecutionKey = { readonly issuer: string; readonly commandId: string };
export type ExecutionAdmission = ExecutionKey & {
	readonly executor: string;
	readonly workspace: string;
	readonly scope: string;
	readonly generation: number;
	readonly requestDigest: string;
	readonly admittedAt: number;
	readonly leaseUntil: number;
	readonly reconcilable: boolean;
};
export type FrozenCall = { readonly name: string; readonly args: StoreValue; readonly digest: string };
export type ExecutionOutcome =
	| { readonly reason: "result"; readonly value: StoreValue; readonly hooksRan: boolean; readonly uncertain: false }
	| {
			readonly reason: "cancelled" | "lease_expired" | "hand_restarted" | "uncertain";
			readonly hooksRan: boolean;
			readonly uncertain: boolean;
	  };
export type ExecutionProgress =
	| { readonly state: "admitted" | "preparing" }
	| { readonly state: "prepared" | "prepared_awaiting_consent" | "released" | "dispatched"; readonly call: FrozenCall }
	| { readonly state: "reconciling"; readonly call: FrozenCall; readonly until: number }
	| { readonly state: "settled"; readonly outcome: ExecutionOutcome }
	| { readonly state: "acked" };
export type ExecutionEntry = ExecutionAdmission & {
	readonly initialLeaseUntil: number;
	readonly renewSeq: number;
	readonly effectPossible: boolean;
	readonly bodyDispatched: boolean;
	readonly progress: ExecutionProgress;
};
export type ExecutionEvent =
	| {
			readonly kind:
				| "prepare"
				| "effect"
				| "consent"
				| "release"
				| "dispatch"
				| "cancel"
				| "abort"
				| "ack"
				| "expire"
				| "restart";
	  }
	| { readonly kind: "freeze"; readonly call: FrozenCall; readonly awaitingConsent: boolean }
	| { readonly kind: "result"; readonly value: StoreValue }
	| { readonly kind: "renew"; readonly seq: number; readonly leaseUntil: number };
export type ExecutionCommand = {
	readonly key: ExecutionKey;
	readonly generation: number;
	/** Verified identity and workspace approval, supplied by the authenticated endpoint, never by a wire body. */
	readonly actor: { readonly id: string; readonly approvedWorkspace?: string };
	readonly now: number;
	readonly event: ExecutionEvent;
};
export type LedgerRefusal =
	| "not_found"
	| "identity_conflict"
	| "invalid_admission"
	| "stale_generation"
	| "unauthorized"
	| "invalid_transition"
	| "invalid_renewal"
	| "invalid_time"
	| "terminal";
export type LedgerReply =
	| { readonly status: "applied" | "replayed"; readonly entry: ExecutionEntry }
	| { readonly status: "refused"; readonly reason: LedgerRefusal }
	| { readonly status: "result_expired" };

export const MAX_EXECUTION_LIFETIME_MS = 86_400_000;
export const RECONCILIATION_GRACE_MS = 30_000;

export const refused = (reason: LedgerRefusal): LedgerReply => ({ status: "refused", reason });
export const replayed = (entry: ExecutionEntry): LedgerReply =>
	entry.progress.state === "acked" ? { status: "result_expired" } : { status: "replayed", entry };
export const applied = (entry: ExecutionEntry): LedgerReply => ({ status: "applied", entry });
