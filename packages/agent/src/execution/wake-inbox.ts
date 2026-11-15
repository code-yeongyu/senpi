import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import { isStoreObject } from "./wake-outbox-record.ts";
import {
	WAKE_RETENTION_MS,
	type WakeEvent,
	type WakeInboxRecord,
	type WakeReceipt,
	type WakeRefusal,
} from "./wake-types.ts";

export interface WakeInboxOptions {
	readonly issuer: string;
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
	readonly clock: () => number;
	/** The authenticated hand bound to a scope (design 5.6.6), or undefined for a scope this brain does not own (yet): such a wake is refused unknown_scope and re-offered by the hand. */
	readonly owner: (scope: string) => string | undefined;
	/**
	 * A wake the loop could not take (its consumer threw). With it, one such wake never holds the queue: it is reported
	 * here, stays pending for later drains, and is taken as `poisoned` (reported once more) at its `maxAttempts`-th
	 * failure, while every wake behind it is delivered. Without it, a failure stops the drain and rejects it, as before.
	 */
	readonly onUndeliverable?: (failure: WakeDeliveryFailure) => void;
	/** Failed deliveries before a wake is poisoned; default 3. */
	readonly maxAttempts?: number;
}

export interface WakeDeliveryFailure {
	readonly wake: WakeEvent;
	readonly error: unknown;
	/** This failure's number, from 1. */
	readonly attempts: number;
	/** The wake was taken without being delivered: it is never offered to the loop again. */
	readonly poisoned: boolean;
}

/** The brain side of design 5.6.4: deduplicated by event id, acked only after the commit. */
export interface WakeInbox {
	/** `sender` is the authenticated hand. The returned `ack` is the `wake_ack` to send; it exists only once committed. */
	/**
	 * `check` is the brain's own answer for a wake of a bound scope (for example `scopeSessionCheck`); it runs after the
	 * scope binding is checked and before anything is committed.
	 */
	receive(sender: string, wake: WakeEvent, check?: (wake: WakeEvent) => WakeRefusal | undefined): Promise<WakeReceipt>;
	/** Hands each committed wake to the loop, then removes it; drains run one at a time, and a crash in between hands the same wake over again, so the consumer is idempotent by event id. */
	drain(consume: (wake: WakeEvent) => Promise<void>): Promise<number>;
	closeScope(scope: string): Promise<void>;
	/** Forgets the event ids of scopes closed longer ago than the retention; the close stays, so a late wake is refused. */
	sweep(): Promise<readonly string[]>;
	read(): Promise<WakeInboxRecord>;
}

const KIND = "execution.wake-inbox";

/** The record with `failures`, omitted while none is counted (so a record that never failed keeps its shape). */
const withFailures = (record: WakeInboxRecord, failures: { readonly [eventId: string]: number }): WakeInboxRecord => {
	const { failures: _previous, ...rest } = record;
	return Object.keys(failures).length === 0 ? rest : { ...rest, failures };
};
const EMPTY: WakeInboxRecord = { seen: {}, pending: [], closed: {} };

function decode(value: StoreValue | undefined): WakeInboxRecord {
	if (value === undefined) return EMPTY;
	if (isStoreObject(value) && isStoreObject(value.seen) && Array.isArray(value.pending) && isStoreObject(value.closed))
		return value as WakeInboxRecord;
	throw new Error("corrupt wake inbox record");
}

export function createWakeInbox(options: WakeInboxOptions): WakeInbox {
	const { issuer, store, epoch, admission, clock, owner } = options;
	const key = `${KIND}:${JSON.stringify([issuer])}`;
	const read = async (): Promise<WakeInboxRecord> => decode(await store.getDocument(key));
	const write = async (record: WakeInboxRecord, step: string, eventId: string | null): Promise<void> => {
		await store.commit(
			epoch,
			[
				{ op: "append", id: store.mintId(), kind: KIND, data: { step, executionId: eventId } },
				{ op: "put", key, data: record },
			],
			() => {},
		);
	};
	const update = <T>(decide: (record: WakeInboxRecord) => Promise<T>): Promise<T> =>
		admission.admit(async () => decide(await read()));

	const maxAttempts = options.maxAttempts ?? 3;
	/** Removes a wake from the pending list (and its failure count) under `step`. */
	const take = (wake: WakeEvent, step: "take" | "poison") =>
		update(async (record) => {
			if (!record.pending.some((entry) => entry.eventId === wake.eventId)) return;
			const pending = record.pending.filter((entry) => entry.eventId !== wake.eventId);
			const { [wake.eventId]: _counted, ...failures } = record.failures ?? {};
			await write(withFailures({ ...record, pending }, failures), step, wake.eventId);
		});
	/** Counts one failed delivery; at `maxAttempts` the wake is poisoned (taken), otherwise it stays pending. */
	const failed = async (wake: WakeEvent, error: unknown, report: NonNullable<WakeInboxOptions["onUndeliverable"]>) => {
		const attempts = ((await read()).failures?.[wake.eventId] ?? 0) + 1;
		const poisoned = attempts >= maxAttempts;
		if (poisoned) await take(wake, "poison");
		else
			await update(async (record) => {
				const failures = { ...record.failures, [wake.eventId]: attempts };
				await write(withFailures(record, failures), "failed", wake.eventId);
			});
		report({ wake, error, attempts, poisoned });
	};

	let draining: Promise<unknown> = Promise.resolve();
	const drainOnce = async (consume: (wake: WakeEvent) => Promise<void>): Promise<number> => {
		let taken = 0;
		for (const wake of (await read()).pending) {
			try {
				await consume(wake);
			} catch (error) {
				const report = options.onUndeliverable;
				if (report === undefined) throw error;
				await failed(wake, error, report);
				continue;
			}
			await take(wake, "take");
			taken += 1;
		}
		return taken;
	};

	return {
		read,
		receive: (sender, wake, check) =>
			update(async (record) => {
				const bound = owner(wake.scope);
				if (bound === undefined) return { kind: "refused", eventId: wake.eventId, reason: "unknown_scope" };
				if (bound !== sender) return { kind: "refused", eventId: wake.eventId, reason: "not_scope_hand" };
				const refusal = check?.(wake);
				if (refusal !== undefined) return { kind: "refused", eventId: wake.eventId, reason: refusal };
				const seen = record.seen[wake.scope] ?? [];
				if (seen.includes(wake.eventId)) return { kind: "ack", eventId: wake.eventId, duplicate: true };
				if (record.closed[wake.scope] !== undefined)
					return { kind: "refused", eventId: wake.eventId, reason: "scope_closed" };
				await write(
					{
						...record,
						seen: { ...record.seen, [wake.scope]: [...seen, wake.eventId] },
						pending: [...record.pending, wake],
					},
					"commit",
					wake.eventId,
				);
				return { kind: "ack", eventId: wake.eventId, duplicate: false };
			}),
		drain: (consume) => {
			const run = draining.then(() => drainOnce(consume));
			draining = run.catch(() => undefined);
			return run;
		},
		closeScope: (scope) =>
			update(async (record) => {
				if (record.closed[scope] !== undefined) return;
				await write({ ...record, closed: { ...record.closed, [scope]: clock() } }, "close", null);
			}),
		sweep: () =>
			update(async (record) => {
				const now = clock();
				const gone = Object.entries(record.closed)
					.filter(([scope, closedAt]) => now > closedAt + WAKE_RETENTION_MS && record.seen[scope] !== undefined)
					.map(([scope]) => scope);
				if (gone.length === 0) return [];
				const drop = new Set(gone);
				await write(
					{
						...record,
						seen: Object.fromEntries(Object.entries(record.seen).filter(([scope]) => !drop.has(scope))),
					},
					"sweep",
					null,
				);
				return gone;
			}),
	};
}
