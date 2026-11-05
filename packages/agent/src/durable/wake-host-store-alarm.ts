import type { DurableStore } from "./store.ts";

/** Where a timer host keeps one session's armed alarm, durably. */
export interface AlarmPersistence {
	read(): Promise<number | undefined>;
	/** Durably arm at `at`, or clear with `undefined`. */
	write(at: number | undefined): Promise<void>;
}

const WAKE_ALARM_DOCUMENT = "durable.wake.alarm";

/**
 * The alarm as a document in the session's own DurableStore, written under the owner `epoch`: an old owner's alarm
 * write is refused (`stale-epoch`) like any other write of it, and the alarm moves with the store on claim + import.
 */
export function storeAlarmPersistence(store: DurableStore, epoch: number): AlarmPersistence {
	return {
		read: async () => {
			const at = await store.getDocument(WAKE_ALARM_DOCUMENT);
			return typeof at === "number" ? at : undefined;
		},
		write: async (at) => {
			const write =
				at === undefined
					? ({ op: "delete", key: WAKE_ALARM_DOCUMENT } as const)
					: ({ op: "put", key: WAKE_ALARM_DOCUMENT, data: at } as const);
			await store.commit(epoch, [write], () => {});
		},
	};
}
