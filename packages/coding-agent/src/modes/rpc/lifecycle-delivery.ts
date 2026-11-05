import type { SessionLifecycle } from "../../core/session-lifecycle-types.ts";

/** Additive wire metadata; older peers may omit it. Never part of the durable snapshot. */
export type RpcSessionLifecycle = SessionLifecycle & { readonly observedAt?: string };

/** A delivery timestamp describes this copy, not engine progress or liveness. */
export function observeLifecycle<T extends object>(lifecycle: T): T & { readonly observedAt: string } {
	return { ...lifecycle, observedAt: new Date(Date.now()).toISOString() };
}

/** Re-stamp at the host enqueue boundary, including replies from cached worker state. */
export function observeLifecycleDelivery(record: object): object {
	if (!("type" in record)) return record;
	if (record.type === "session_lifecycle") return observeState(record);
	if (record.type !== "response" || !("command" in record) || !("data" in record)) return record;
	const data = record.data;
	if (typeof data !== "object" || data === null) return record;
	if (record.command === "get_state") return { ...record, data: observeState(data) };
	if (record.command === "open_session" && "state" in data && typeof data.state === "object" && data.state !== null)
		return { ...record, data: { ...data, state: observeState(data.state) } };
	return record;
}

function observeState(state: object): object {
	if (!("lifecycle" in state) || typeof state.lifecycle !== "object" || state.lifecycle === null) return state;
	return { ...state, lifecycle: observeLifecycle(state.lifecycle) };
}
