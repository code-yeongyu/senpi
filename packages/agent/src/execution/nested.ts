import type { DurableStore } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import type {
	ActivityRefusal,
	NestedActivity,
	NestedAdmission,
	NestedCancelTarget,
	NestedParent,
	NestedRecord,
	NestedRequest,
} from "./nested-types.ts";

export interface NestedAdmissionOptions {
	/** The brain's issuer: every parent and child here is one of its executions. */
	readonly issuer: string;
	readonly store: DurableStore;
	readonly epoch: number;
	/** The single admission line of the store's writable epoch: the brain is the single writer, so a cancel and a child
	 * admission are linearized here. */
	readonly admission: AdmissionLine;
	readonly clock: () => number;
}

/**
 * Nested requests admitted on the brain that owns the parent execution (design 5.6.3). Every step is durable before
 * the reply it causes; a replay of the same `(parent, childRequestId)` returns the same child and is never debited twice.
 */
export interface NestedAdmissionControl {
	/** Writes the parent's nested set, scoped to preparation, before its prepare is sent. Idempotent. */
	open(parent: NestedParent): Promise<void>;
	release(parent: string): Promise<void>;
	/** The parent's invocation is terminal: only its live activities still admit. */
	settle(parent: string): Promise<void>;
	/** Follows a parent renewal: the set's expiry moves forward, never past the lease or the parent's lifetime. */
	renew(parent: string, leaseUntil: number): Promise<number>;
	registerActivity(
		activity: NestedActivity,
	): Promise<{ readonly kind: "registered" } | { readonly kind: "refused"; readonly reason: ActivityRefusal }>;
	endActivity(parent: string, activityId: string): Promise<void>;
	admit(request: NestedRequest): Promise<NestedAdmission>;
	/** Cancels the parent and every child: the cascade is durably queued, then delivered by `deliverCancels`. */
	cancel(parent: string): Promise<readonly NestedCancelTarget[]>;
	/** Sends every queued cascade to its child's executor and marks it delivered; re-sent after a restart until then. */
	deliverCancels(parent: string, send: (target: NestedCancelTarget) => Promise<void>): Promise<number>;
	read(parent: string): Promise<NestedRecord | undefined>;
}

export function createNestedAdmission(_options: NestedAdmissionOptions): NestedAdmissionControl {
	return {
		read: async () => undefined,
		open: async () => {},
		release: async () => {},
		settle: async () => {},
		renew: async (_parent, leaseUntil) => leaseUntil,
		registerActivity: async () => ({ kind: "registered" }),
		endActivity: async () => {},
		admit: async () => ({ kind: "refused", reason: "unknown_parent" }),
		cancel: async () => [],
		deliverCancels: async () => 0,
	};
}
