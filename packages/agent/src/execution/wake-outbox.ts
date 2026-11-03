import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import { WAKE_RETENTION_MS, type WakeEvent, type WakeOutboxRecord, type WakeReceipt } from "./wake-types.ts";

export interface WakeOutboxOptions {
	/** The hand this outbox belongs to; every event id it mints starts with it. */
	readonly hand: string;
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
	readonly clock: () => number;
}

/** The hand side of design 5.6.4: a wake is durable before it is sent and removed only by its `wake_ack`. */
export interface WakeOutbox {
	/** Commits the wake and returns it; the caller sends it (or a later `reoffer` does). */
	offer(wake: Omit<WakeEvent, "eventId">): Promise<WakeEvent>;
	/** Sends every un-acked wake in offer order (on reconnect); a refused or failed send leaves it pending. */
	reoffer(send: (wake: WakeEvent) => Promise<WakeReceipt>): Promise<number>;
	/** Applies one brain answer: an ack removes the wake; a refusal keeps it for retention. Idempotent. */
	receipt(receipt: WakeReceipt): Promise<void>;
	/** The scope closed: its un-acked wakes are kept until `closedAt + WAKE_RETENTION_MS`. */
	closeScope(scope: string): Promise<void>;
	/** Drops the wakes past retention, each with a logged `wake_expired` record; returns their ids. */
	sweep(): Promise<readonly string[]>;
	pending(): Promise<readonly WakeEvent[]>;
}

const KIND = "execution.wake-outbox";
const EMPTY: WakeOutboxRecord = { pending: [], closed: {} };

export const isStoreObject = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function decode(value: StoreValue | undefined): WakeOutboxRecord {
	if (value === undefined) return EMPTY;
	if (isStoreObject(value) && Array.isArray(value.pending) && isStoreObject(value.closed))
		return value as WakeOutboxRecord;
	throw new Error("corrupt wake outbox record");
}

export function createWakeOutbox(options: WakeOutboxOptions): WakeOutbox {
	const { hand, store, epoch, admission, clock } = options;
	const key = `${KIND}:${JSON.stringify([hand])}`;
	const read = async (): Promise<WakeOutboxRecord> => decode(await store.getDocument(key));
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

	const receipt = (answer: WakeReceipt): Promise<void> =>
		update(async (record) => {
			if (answer.kind !== "ack" || !record.pending.some((wake) => wake.eventId === answer.eventId)) return;
			const pending = record.pending.filter((wake) => wake.eventId !== answer.eventId);
			await write({ ...record, pending }, "ack", answer.eventId);
		});

	return {
		offer: (wake) =>
			update(async (record) => {
				const event: WakeEvent = { ...wake, eventId: `${hand}:${store.mintId()}` };
				await write({ ...record, pending: [...record.pending, event] }, "offer", event.eventId);
				return event;
			}),
		reoffer: async (send) => {
			let sent = 0;
			for (const wake of (await read()).pending) {
				await receipt(await send(wake));
				sent += 1;
			}
			return sent;
		},
		receipt,
		closeScope: (scope) =>
			update(async (record) => {
				if (record.closed[scope] !== undefined) return;
				await write({ ...record, closed: { ...record.closed, [scope]: clock() } }, "close", null);
			}),
		sweep: () =>
			update(async (record) => {
				const now = clock();
				const expired = record.pending.filter((wake) => {
					const closedAt = record.closed[wake.scope];
					return closedAt !== undefined && now > closedAt + WAKE_RETENTION_MS;
				});
				if (expired.length === 0) return [];
				const gone = new Set(expired.map((wake) => wake.eventId));
				await write(
					{ ...record, pending: record.pending.filter((wake) => !gone.has(wake.eventId)) },
					"sweep",
					null,
					expired.map((wake) => ({ reason: "wake_expired", eventId: wake.eventId, scope: wake.scope })),
				);
				return [...gone];
			}),
		pending: async () => (await read()).pending,
	};
}
