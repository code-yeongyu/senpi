import type { DerivedSessionStatus, SessionStatusLastEffect, SessionStatusRecord } from "./session-status.ts";
import type { SubscriptionOptions } from "./session-status-subscriptions.ts";

/** Shared projection for inline legacy snapshots and the compact snapshot's streaming passes. */
export function statusRecord(
	subscription: { readonly id: string; readonly seq: number; readonly options: SubscriptionOptions },
	sessionId: string,
	derived: DerivedSessionStatus,
	lastChange: SessionStatusRecord["lastChange"],
	lastEffect: SessionStatusLastEffect | undefined,
): SessionStatusRecord {
	const { context, ...rest } = derived;
	return {
		type: "session_status",
		subscriptionId: subscription.id,
		seq: subscription.seq,
		sessionId,
		...rest,
		...(subscription.options.includeContext ? { context } : {}),
		...(lastEffect !== undefined ? { lastEffect } : {}),
		lastChange,
		...(subscription.seq > 0 && subscription.options.admissionId !== undefined
			? { admissionId: subscription.options.admissionId, generation: 0 }
			: {}),
	};
}
