import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import { isStoreObject } from "./wake-outbox.ts";
import { WAKE_RETENTION_MS, type WakeEvent, type WakeInboxRecord, type WakeReceipt } from "./wake-types.ts";

export interface WakeInboxOptions {
	readonly issuer: string;
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
	readonly clock: () => number;
	/** The authenticated hand bound to a scope (design 5.6.6), or undefined for a scope this brain does not own (yet): such a wake is refused unknown_scope and re-offered by the hand. */
	readonly owner: (scope: string) => string | undefined;
}

/** The brain side of design 5.6.4: deduplicated by event id, acked only after the commit. */
export interface WakeInbox {
	/** `sender` is the authenticated hand. The returned `ack` is the `wake_ack` to send; it exists only once committed. */
	receive(sender: string, wake: WakeEvent): Promise<WakeReceipt>;
	/** Hands each committed wake to the loop, then removes it; drains run one at a time, and a crash in between hands the same wake over again, so the consumer is idempotent by event id. */
	drain(consume: (wake: WakeEvent) => Promise<void>): Promise<number>;
	closeScope(scope: string): Promise<void>;
	/** Forgets the event ids of scopes closed longer ago than the retention; the close stays, so a late wake is refused. */
	sweep(): Promise<readonly string[]>;
	read(): Promise<WakeInboxRecord>;
}

const KIND = "execution.wake-inbox";
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

	let draining: Promise<unknown> = Promise.resolve();
	const drainOnce = async (consume: (wake: WakeEvent) => Promise<void>): Promise<number> => {
		let taken = 0;
		for (const wake of (await read()).pending) {
			await consume(wake);
			await update(async (record) => {
				if (!record.pending.some((entry) => entry.eventId === wake.eventId)) return;
				const pending = record.pending.filter((entry) => entry.eventId !== wake.eventId);
				await write({ ...record, pending }, "take", wake.eventId);
			});
			taken += 1;
		}
		return taken;
	};

	return {
		read,
		receive: (sender, wake) =>
			update(async (record) => {
				const bound = owner(wake.scope);
				if (bound === undefined) return { kind: "refused", eventId: wake.eventId, reason: "unknown_scope" };
				if (bound !== sender) return { kind: "refused", eventId: wake.eventId, reason: "not_scope_hand" };
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
						seen: Object.fromEntries(Object.entries(record.seen).filter(([scope]) => !drop.has(scope))),
						pending: record.pending,
						closed: record.closed,
					},
					"sweep",
					null,
				);
				return gone;
			}),
	};
}
