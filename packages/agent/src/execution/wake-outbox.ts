import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import { addDrop, decodeOutbox, malformedScope } from "./wake-outbox-record.ts";
import {
	WAKE_RETENTION_MS,
	type WakeDropReason,
	type WakeEvent,
	type WakeLimits,
	type WakeOutboxRecord,
	type WakeReceipt,
} from "./wake-types.ts";

export interface WakeOutboxOptions {
	/** The hand this outbox belongs to; every event id it mints starts with it. */
	readonly hand: string;
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
	readonly clock: () => number;
	/** The un-acked bound; past it the oldest wake is dropped and a drop report (`overflow`) is kept instead. Absent: none. */
	readonly limits?: WakeLimits;
	/** A pending entry that is not a wake: `sweep` drops it and keeps a drop report (`malformed`) under its scope. */
	readonly onFault?: (error: Error) => void;
}

/** The hand side of design 5.6.4: a wake is durable before it is sent and removed only by its `wake_ack`. */
export interface WakeOutbox {
	/** Commits the wake and returns it; the caller sends it (or a later `reoffer` does). */
	offer(wake: Omit<WakeEvent, "eventId">): Promise<WakeEvent>;
	/** Sends every due wake in offer order (on reconnect); a failed send or an unknown scope leaves it for the next re-offer. */
	reoffer(send: (wake: WakeEvent) => Promise<WakeReceipt>): Promise<number>;
	/**
	 * What a re-offer sends: every drop report, then every un-acked wake, but those refused for good (not_scope_hand,
	 * scope_closed, not_scope_session). Drop reports returned here are never coalesced again by this outbox.
	 */
	due(): Promise<readonly WakeEvent[]>;
	/** Applies one brain answer: an ack removes the wake or report; a refusal keeps it until the retention. Idempotent. */
	receipt(receipt: WakeReceipt): Promise<void>;
	/** The scope closed: its un-acked wakes are kept until `closedAt + WAKE_RETENTION_MS`. */
	closeScope(scope: string): Promise<void>;
	/**
	 * Drops what is past retention: wakes of a closed scope (each logged `wake_expired`, and reported per scope as an
	 * `expired` drop), wakes refused for good, and malformed entries (reported `malformed`). Returns the expired wakes' ids.
	 */
	sweep(): Promise<readonly string[]>;
	/** The un-acked wakes, without the drop reports. */
	pending(): Promise<readonly WakeEvent[]>;
}

const KIND = "execution.wake-outbox";

/** The outbox is at its bound with only in-flight wakes: this wake was refused before it was sent, and reported. */
export class WakeOverflowError extends Error {
	override readonly name = "WakeOverflowError";
	readonly wake: WakeEvent;
	constructor(wake: WakeEvent) {
		super(`the hand's wake outbox is full; wake ${wake.eventId} of scope ${wake.scope} was dropped (overflow)`);
		this.wake = wake;
	}
}

export class MalformedWakeError extends Error {
	override readonly name = "MalformedWakeError";
	readonly entry: StoreValue;
	constructor(entry: StoreValue) {
		super(`a malformed wake was dropped from the outbox: ${JSON.stringify(entry)}`);
		this.entry = entry;
	}
}

export function createWakeOutbox(options: WakeOutboxOptions): WakeOutbox {
	const { hand, store, epoch, admission, clock, limits } = options;
	const key = `${KIND}:${JSON.stringify([hand])}`;
	const mint = () => `${hand}:${store.mintId()}`;
	// Drop reports this instance created and never handed to a re-offer: the only ones safe to coalesce into.
	const fresh = new Set<string>();
	const decoded = async () => decodeOutbox(await store.getDocument(key));
	const read = async (): Promise<WakeOutboxRecord> => (await decoded()).record;
	const write = async (record: WakeOutboxRecord, step: string, eventId: string | null, extra: StoreValue[] = []) => {
		const data: StoreValue = { step, eventId };
		await store.commit(
			epoch,
			[
				{ op: "append", id: store.mintId(), kind: KIND, data },
				...extra.map((data) => ({
					op: "append" as const,
					id: store.mintId(),
					kind: "execution.wake-expired",
					data,
				})),
				{ op: "put", key, data: record },
			],
			() => {},
		);
	};
	const update = <T>(decide: (record: WakeOutboxRecord) => Promise<T>): Promise<T> =>
		admission.admit(async () => decide(await read()));
	const withDrops = (record: WakeOutboxRecord, scope: string, reason: WakeDropReason, count: number) => ({
		...record,
		drops: addDrop(record.drops, { scope, reason, count }, fresh, mint),
	});

	/** Removes a wake and every bit of its state, reporting it as `reason` under its own scope. */
	const evict = (record: WakeOutboxRecord, wake: WakeEvent, reason: WakeDropReason): WakeOutboxRecord => {
		const { [wake.eventId]: _gone, ...refused } = record.refused;
		const pending = record.pending.filter((entry) => entry.eventId !== wake.eventId);
		return withDrops({ ...record, pending, refused }, wake.scope, reason, 1);
	};
	/**
	 * Past a bound, only a wake the brain refused for good is evicted: it is never sent again, so nothing in flight is
	 * lost. Every other pending wake may already be on its way to the brain (review round 2, L6), so when none can go the
	 * new wake is the one refused: `undefined`, and it is never sent.
	 */
	const bounded = (record: WakeOutboxRecord, scope: string): WakeOutboxRecord | undefined => {
		if (limits === undefined) return record;
		let next = record;
		const over = () =>
			next.pending.filter((wake) => wake.scope === scope).length > limits.perScope ||
			next.pending.length > limits.total;
		while (over()) {
			const inScope = next.pending.filter((wake) => wake.scope === scope).length > limits.perScope;
			const evictable = next.pending.find(
				(wake) => next.refused[wake.eventId] !== undefined && (!inScope || wake.scope === scope),
			);
			if (evictable === undefined) return undefined;
			next = evict(next, evictable, "refused");
		}
		return next;
	};

	const receipt = (answer: WakeReceipt): Promise<void> =>
		update(async (record) => {
			const known = [...record.pending, ...record.drops].some((wake) => wake.eventId === answer.eventId);
			if (!known) return;
			if (answer.kind === "refused") {
				// The scope may not be bound yet (a brain restart, a bind racing this outbox): only a refusal that cannot change
				// is recorded and stops the re-offers.
				if (answer.reason === "unknown_scope" || record.refused[answer.eventId] !== undefined) return;
				const refusal = { reason: answer.reason, at: clock() };
				await write(
					{ ...record, refused: { ...record.refused, [answer.eventId]: refusal } },
					"refused",
					answer.eventId,
				);
				return;
			}
			const kept = (wake: WakeEvent) => wake.eventId !== answer.eventId;
			const { [answer.eventId]: _settled, ...refused } = record.refused;
			const settled = { ...record, pending: record.pending.filter(kept), drops: record.drops.filter(kept), refused };
			await write(settled, "ack", answer.eventId);
		});

	const due = async (): Promise<readonly WakeEvent[]> => {
		const record = await read();
		for (const report of record.drops) fresh.delete(report.eventId);
		return [...record.drops, ...record.pending].filter((wake) => record.refused[wake.eventId] === undefined);
	};

	return {
		offer: (wake) =>
			update(async (record) => {
				const event: WakeEvent = { ...wake, eventId: mint() };
				const next = bounded({ ...record, pending: [...record.pending, event] }, event.scope);
				if (next === undefined) {
					await write(withDrops(record, event.scope, "overflow", 1), "overflow", event.eventId);
					throw new WakeOverflowError(event);
				}
				await write(next, "offer", event.eventId);
				return event;
			}),
		reoffer: async (send) => {
			const wakes = await due();
			for (const wake of wakes) await receipt(await send(wake));
			return wakes.length;
		},
		due,
		receipt,
		closeScope: (scope) =>
			update(async (record) => {
				if (record.closed[scope] !== undefined) return;
				await write({ ...record, closed: { ...record.closed, [scope]: clock() } }, "close", null);
			}),
		sweep: () =>
			admission.admit(async () => {
				const { record, malformed } = await decoded();
				const now = clock();
				const lapsed = (wake: WakeEvent) => {
					const closedAt = record.closed[wake.scope];
					const refusedAt = record.refused[wake.eventId]?.at;
					return (
						(closedAt !== undefined && now > closedAt + WAKE_RETENTION_MS) ||
						(refusedAt !== undefined && now > refusedAt + WAKE_RETENTION_MS)
					);
				};
				const expired = record.pending.filter(lapsed);
				const lapsedDrops = record.drops.filter(lapsed);
				// A refusal whose wake is gone (an older outbox evicted it without its state) is purged.
				const held = new Set([...record.pending, ...record.drops].map((wake) => wake.eventId));
				const orphans = Object.keys(record.refused).filter((eventId) => !held.has(eventId));
				if (expired.length + lapsedDrops.length + malformed.length + orphans.length === 0) return [];
				const gone = new Set([...expired, ...lapsedDrops].map((wake) => wake.eventId).concat(orphans));
				let next: WakeOutboxRecord = {
					...record,
					pending: record.pending.filter((wake) => !gone.has(wake.eventId)),
					drops: record.drops.filter((wake) => !gone.has(wake.eventId)),
					refused: Object.fromEntries(Object.entries(record.refused).filter(([eventId]) => !gone.has(eventId))),
				};
				// A lapsed wake is reported: `refused` when the brain refused it for good (review round 2, M4), else `expired`.
				for (const wake of expired)
					next = withDrops(
						next,
						wake.scope,
						record.refused[wake.eventId] === undefined ? "expired" : "refused",
						1,
					);
				for (const entry of malformed) {
					options.onFault?.(new MalformedWakeError(entry));
					const scope = malformedScope(entry);
					if (scope !== undefined) next = withDrops(next, scope, "malformed", 1);
				}
				await write(
					next,
					"sweep",
					null,
					expired.map((wake) => ({ reason: "wake_expired", eventId: wake.eventId, scope: wake.scope })),
				);
				return expired.map((wake) => wake.eventId);
			}),
		pending: async () => (await read()).pending,
	};
}
