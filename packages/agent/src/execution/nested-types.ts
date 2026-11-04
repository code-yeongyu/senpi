import type { ExecutionRef } from "./coordinator-types.ts";

/** 0010's lifetime of an execution: a nested set never outlives its parent's admission by more than this. */
export const NESTED_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The parent execution a nested set belongs to, as the brain recorded it when it sent the parent's prepare. */
export type NestedParent = {
	readonly executionId: string;
	readonly generation: number;
	/** The executor the parent was sent to: the only sender whose nested requests name this parent. */
	readonly executor: string;
	readonly scope: string;
	readonly admittedAt: number;
	readonly leaseUntil: number;
	/** The aggregate reservation every child (and every activity's child) is debited from. */
	readonly budget: number;
	/** Targets a nested request may name: `preparation` from the prepare on, `body` added at release. */
	readonly capabilities: { readonly preparation: readonly string[]; readonly body: readonly string[] };
};

/** A coordinator-owned background activity of a detached cell (design 5.6.3), registered before the detached result. */
export type NestedActivity = {
	readonly activityId: string;
	readonly parent: string;
	readonly executor: string;
	readonly scope: string;
	/** A subset of the parent's targets: the activity never holds authority the parent did not. */
	readonly targets: readonly string[];
	readonly budget: number;
	readonly expiresAt: number;
};

/** A nested request as the brain's endpoint hands it over; `sender` is the authenticated hand, never a claim. */
export type NestedRequest = {
	readonly sender: string;
	readonly parent: string;
	readonly parentGeneration: number;
	readonly scope: string;
	readonly childRequestId: string;
	/** The executor the child runs on. */
	readonly target: string;
	readonly cost: number;
	/** Set by a detached cell: admitted against the live activity, never by reviving the terminal invocation. */
	readonly activityId?: string;
};

export type NestedRefusal =
	| "unknown_parent"
	| "not_parent_executor"
	| "stale_generation"
	| "scope_mismatch"
	| "parent_terminal"
	| "expired"
	| "not_in_nested_set"
	| "budget_exhausted"
	| "invalid_cost"
	| "unknown_activity"
	| "activity_ended"
	| "conflicting_request";

/** A child is tool-originated work, never human intent. */
export type NestedChild = {
	readonly executionId: string;
	readonly target: string;
	readonly cost: number;
	readonly origin: "tool";
	readonly activityId: string | null;
};

export type NestedAdmission =
	| { readonly kind: "admitted"; readonly child: ExecutionRef; readonly target: string; readonly replayed: boolean }
	| { readonly kind: "refused"; readonly reason: NestedRefusal };

export type ActivityRefusal = "parent_terminal" | "unknown_parent" | "exceeds_parent" | "conflicting_activity";

export type ActivityRecord = NestedActivity & { readonly debited: number; readonly ended: boolean };

/** The brain's durable record of one parent's nested work. */
export type NestedRecord = {
	readonly parent: NestedParent;
	readonly phase: "preparation" | "body" | "settled";
	readonly cancelled: boolean;
	/** The nested set's expiry: follows the parent's renewals, never past its lease or its lifetime. */
	readonly expiresAt: number;
	readonly debited: number;
	readonly children: { readonly [childRequestId: string]: NestedChild };
	readonly activities: { readonly [activityId: string]: ActivityRecord };
	/** The parent cancel's cascade, per child execution id: queued until its executor took it. */
	readonly cancels: { readonly [childExecutionId: string]: "queued" | "delivered" };
};

/** Where a parent cancel is delivered: the child's executor, with 0010 cancel semantics. */
export type NestedCancelTarget = { readonly ref: ExecutionRef; readonly executor: string };
