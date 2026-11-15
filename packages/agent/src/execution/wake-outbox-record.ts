import type { StoreValue } from "../durable/store.ts";
import {
	WAKE_DROPPED_SOURCE,
	type WakeDropReason,
	type WakeEvent,
	type WakeOutboxRecord,
	type WakeRefusal,
} from "./wake-types.ts";

const REFUSALS: readonly string[] = ["not_scope_hand", "unknown_scope", "scope_closed", "not_scope_session"];

export const isStoreObject = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const isId = (value: StoreValue | undefined): value is string => typeof value === "string" && value.length > 0;

function wakeOf(value: StoreValue): WakeEvent | undefined {
	if (!isStoreObject(value) || !isId(value.eventId) || !isId(value.scope) || !isId(value.source)) return undefined;
	if (!("payload" in value)) return undefined;
	return { eventId: value.eventId, scope: value.scope, source: value.source, payload: value.payload ?? null };
}

function refusalOf(value: StoreValue | undefined): { readonly reason: WakeRefusal; readonly at: number } | undefined {
	if (!isStoreObject(value) || typeof value.at !== "number" || typeof value.reason !== "string") return undefined;
	return REFUSALS.includes(value.reason) ? { reason: value.reason as WakeRefusal, at: value.at } : undefined;
}

/** A record as read: its well-formed entries, and the raw entries that are not wakes (dropped at the next sweep). */
export interface DecodedOutbox {
	readonly record: WakeOutboxRecord;
	readonly malformed: readonly StoreValue[];
}

/**
 * Parses the outbox document strictly (senpi#6767 review L2): every pending wake and drop report must be a whole
 * wake, every refusal a known reason with its time. Anything else is set aside, never offered, and dropped by `sweep`.
 * A document that is not an outbox record at all is corrupt and throws.
 */
export function decodeOutbox(value: StoreValue | undefined): DecodedOutbox {
	if (value === undefined) return { record: { pending: [], drops: [], refused: {}, closed: {} }, malformed: [] };
	if (!isStoreObject(value) || !Array.isArray(value.pending) || !isStoreObject(value.closed))
		throw new Error("corrupt wake outbox record");
	const malformed: StoreValue[] = [];
	const wakes = (list: StoreValue | undefined): WakeEvent[] =>
		(Array.isArray(list) ? list : []).flatMap((entry) => {
			const wake = wakeOf(entry);
			if (wake === undefined) malformed.push(entry);
			return wake === undefined ? [] : [wake];
		});
	const refused = Object.fromEntries(
		Object.entries(isStoreObject(value.refused) ? value.refused : {}).flatMap(([eventId, entry]) => {
			const refusal = refusalOf(entry);
			return refusal === undefined ? [] : [[eventId, refusal]];
		}),
	);
	const closed = Object.fromEntries(
		Object.entries(value.closed).flatMap(([scope, at]) => (typeof at === "number" ? [[scope, at]] : [])),
	);
	return { record: { pending: wakes(value.pending), drops: wakes(value.drops), refused, closed }, malformed };
}

/** The scope a malformed entry names, if it names one; it is reported under that scope. */
export function malformedScope(entry: StoreValue): string | undefined {
	return isStoreObject(entry) && isId(entry.scope) ? entry.scope : undefined;
}

/**
 * Adds `count` drops of `reason` in `scope` to the drop reports. A report not yet sent by this outbox instance (`fresh`)
 * is coalesced, so a brain that stays away gets one report per scope and reason, not one per dropped wake. A report
 * this process (or an earlier one) may have sent keeps its count: the brain deduplicates by its event id.
 */
export function addDrop(
	drops: readonly WakeEvent[],
	drop: { readonly scope: string; readonly reason: WakeDropReason; readonly count: number },
	fresh: Set<string>,
	mint: () => string,
): readonly WakeEvent[] {
	const at = drops.findLastIndex(
		(report) =>
			fresh.has(report.eventId) &&
			report.scope === drop.scope &&
			isStoreObject(report.payload) &&
			report.payload.reason === drop.reason,
	);
	const previous = at === -1 ? undefined : drops[at];
	if (previous !== undefined && isStoreObject(previous.payload) && typeof previous.payload.count === "number") {
		const merged: WakeEvent = {
			...previous,
			payload: { reason: drop.reason, count: previous.payload.count + drop.count },
		};
		return drops.map((report, index) => (index === at ? merged : report));
	}
	const eventId = mint();
	fresh.add(eventId);
	const report: WakeEvent = {
		eventId,
		scope: drop.scope,
		source: WAKE_DROPPED_SOURCE,
		payload: { reason: drop.reason, count: drop.count },
	};
	return [...drops, report];
}
