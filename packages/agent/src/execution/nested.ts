import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import { decodeNestedRecord } from "./nested-codec.ts";
import {
	type ActivityRefusal,
	type NestedActivity,
	type NestedAdmission,
	type NestedCancelTarget,
	type NestedParent,
	type NestedRecord,
	type NestedRefusal,
	type NestedRequest,
	NESTED_LIFETIME_MS,
} from "./nested-types.ts";

const PREFIX = "execution.nested:";

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

const childId = (parent: string, childRequestId: string): string => `${parent}/${childRequestId}`;

function refused(reason: NestedRefusal): NestedAdmission {
	return { kind: "refused", reason };
}

export function createNestedAdmission(options: NestedAdmissionOptions): NestedAdmissionControl {
	const { issuer, store, epoch, admission, clock } = options;
	const keyOf = (parent: string): string => `${PREFIX}${JSON.stringify([issuer, parent])}`;
	const read = async (parent: string): Promise<NestedRecord | undefined> => {
		const value = await store.getDocument(keyOf(parent));
		return value === undefined ? undefined : decodeNestedRecord(value);
	};
	const write = async (record: NestedRecord, step: string, executionId: string | null): Promise<void> => {
		const data: StoreValue = { parent: record.parent.executionId, step, executionId };
		await store.commit(
			epoch,
			[
				{ op: "append", id: store.mintId(), kind: "execution.nested", data },
				{ op: "put", key: keyOf(record.parent.executionId), data: record },
			],
			() => {},
		);
	};
	/** Reads, decides and writes inside one admission: nothing else on the brain's store interleaves. */
	const update = <T>(parent: string, decide: (record: NestedRecord | undefined) => Promise<T>): Promise<T> =>
		admission.admit(async () => decide(await read(parent)));
	const live = (record: NestedRecord): boolean => !record.cancelled && record.phase !== "settled";
	const set = (record: NestedRecord): readonly string[] =>
		record.phase === "preparation"
			? record.parent.capabilities.preparation
			: [...record.parent.capabilities.preparation, ...record.parent.capabilities.body];

	return {
		read,
		open: (parent) =>
			update(parent.executionId, async (record) => {
				if (record !== undefined) return;
				const expiresAt = Math.min(parent.leaseUntil, parent.admittedAt + NESTED_LIFETIME_MS);
				const opened: NestedRecord = {
					parent,
					phase: "preparation",
					cancelled: false,
					expiresAt,
					debited: 0,
					children: {},
					activities: {},
					cancels: {},
				};
				await write(opened, "open", null);
			}),
		release: (parent) =>
			update(parent, async (record) => {
				if (record === undefined || record.phase !== "preparation" || record.cancelled) return;
				await write({ ...record, phase: "body" }, "release", null);
			}),
		settle: (parent) =>
			update(parent, async (record) => {
				if (record === undefined || !live(record)) return;
				await write({ ...record, phase: "settled" }, "settle", null);
			}),
		renew: (parent, leaseUntil) =>
			update(parent, async (record) => {
				if (record === undefined) throw new Error(`no nested set for ${parent}`);
				const cap = record.parent.admittedAt + NESTED_LIFETIME_MS;
				const expiresAt = Math.max(record.expiresAt, Math.min(leaseUntil, cap));
				if (expiresAt !== record.expiresAt) await write({ ...record, expiresAt }, "renew", null);
				return expiresAt;
			}),
		registerActivity: (activity) =>
			update(activity.parent, async (record) => {
				if (record === undefined) return { kind: "refused", reason: "unknown_parent" } as const;
				const existing = record.activities[activity.activityId];
				if (existing !== undefined)
					return JSON.stringify({ ...existing, debited: 0, ended: false }) ===
						JSON.stringify({ ...activity, debited: 0, ended: false })
						? ({ kind: "registered" } as const)
						: ({ kind: "refused", reason: "conflicting_activity" } as const);
				if (record.cancelled) return { kind: "refused", reason: "parent_terminal" } as const;
				const held = set({ ...record, phase: "body" });
				const subset =
					activity.executor === record.parent.executor &&
					activity.scope === record.parent.scope &&
					activity.targets.every((target) => held.includes(target)) &&
					activity.expiresAt <= record.expiresAt &&
					activity.budget <= record.parent.budget - record.debited;
				if (!subset) return { kind: "refused", reason: "exceeds_parent" } as const;
				const activities = {
					...record.activities,
					[activity.activityId]: { ...activity, debited: 0, ended: false },
				};
				await write({ ...record, activities }, "activity", activity.activityId);
				return { kind: "registered" } as const;
			}),
		endActivity: (parent, activityId) =>
			update(parent, async (record) => {
				const activity = record?.activities[activityId];
				if (record === undefined || activity === undefined || activity.ended) return;
				const activities = { ...record.activities, [activityId]: { ...activity, ended: true } };
				await write({ ...record, activities }, "activity_end", activityId);
			}),
		admit: (request) =>
			update(request.parent, async (record) => {
				if (record === undefined) return refused("unknown_parent");
				const activity = request.activityId === undefined ? undefined : record.activities[request.activityId];
				if (request.activityId !== undefined && activity === undefined) return refused("unknown_activity");
				const owner = activity ?? record.parent;
				if (request.sender !== owner.executor) return refused("not_parent_executor");
				if (request.parentGeneration !== record.parent.generation) return refused("stale_generation");
				if (request.scope !== owner.scope) return refused("scope_mismatch");

				const id = childId(request.parent, request.childRequestId);
				const ref = { issuer, executionId: id, generation: 1 };
				const known = record.children[request.childRequestId];
				if (known !== undefined)
					return known.target === request.target &&
						known.cost === request.cost &&
						known.activityId === (request.activityId ?? null)
						? { kind: "admitted", child: ref, target: known.target, replayed: true }
						: refused("conflicting_request");

				const now = clock();
				if (activity !== undefined) {
					if (activity.ended || record.cancelled || now > activity.expiresAt) return refused("activity_ended");
					if (!activity.targets.includes(request.target)) return refused("not_in_nested_set");
					if (activity.debited + request.cost > activity.budget) return refused("budget_exhausted");
				} else {
					if (!live(record)) return refused("parent_terminal");
					if (now > record.expiresAt) return refused("expired");
					if (!set(record).includes(request.target)) return refused("not_in_nested_set");
				}
				if (record.debited + request.cost > record.parent.budget) return refused("budget_exhausted");

				const child = {
					executionId: id,
					target: request.target,
					cost: request.cost,
					origin: "tool",
					activityId: request.activityId ?? null,
				} as const;
				const activities =
					activity === undefined
						? record.activities
						: {
								...record.activities,
								[activity.activityId]: { ...activity, debited: activity.debited + request.cost },
							};
				await write(
					{
						...record,
						debited: record.debited + request.cost,
						children: { ...record.children, [request.childRequestId]: child },
						activities,
					},
					"admit",
					id,
				);
				return { kind: "admitted", child: ref, target: request.target, replayed: false };
			}),
		cancel: (parent) =>
			update(parent, async (record) => {
				if (record === undefined) return [];
				const targets = Object.values(record.children).map((child) => ({
					ref: { issuer, executionId: child.executionId, generation: 1 },
					executor: child.target,
				}));
				if (record.cancelled) return targets;
				const activities = Object.fromEntries(
					Object.entries(record.activities).map(([id, activity]) => [id, { ...activity, ended: true }]),
				);
				const cancels = Object.fromEntries(
					Object.values(record.children).map((child) => [child.executionId, "queued" as const]),
				);
				await write({ ...record, cancelled: true, activities, cancels }, "cancel", null);
				return targets;
			}),
		deliverCancels: async (parent, send) => {
			const record = await read(parent);
			if (record === undefined) return 0;
			let delivered = 0;
			for (const child of Object.values(record.children)) {
				if (record.cancels[child.executionId] !== "queued") continue;
				await send({ ref: { issuer, executionId: child.executionId, generation: 1 }, executor: child.target });
				await update(parent, async (latest) => {
					if (latest === undefined || latest.cancels[child.executionId] !== "queued") return;
					await write(
						{ ...latest, cancels: { ...latest.cancels, [child.executionId]: "delivered" } },
						"cancel_delivered",
						child.executionId,
					);
				});
				delivered += 1;
			}
			return delivered;
		},
	};
}
