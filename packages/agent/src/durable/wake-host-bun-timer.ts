import type { WakeAlarm, WakeAlarmOptions } from "./wake-host.ts";
import type { AlarmPersistence } from "./wake-host-store-alarm.ts";

/** Schedule `callback` after `ms`; returns its cancel. */
export type SetTimer = (callback: () => unknown, ms: number) => () => void;

export interface BunTimerHostOptions {
	readonly now?: () => number;
	readonly setTimer?: SetTimer;
	/**
	 * The longest single timer. Monotonic timers stop while a machine sleeps, so a far alarm re-checks the wall clock
	 * at least this often and an alarm that fell due during a sleep fires within this bound of waking. Default 60 s.
	 */
	readonly maxDelayMs?: number;
	/** A fire handler rejected. The alarm stays armed and fires again after `maxDelayMs`. */
	readonly onFireError: (key: string, error: unknown) => void;
}

/**
 * The Bun process timer host: one instance serves every session of the process, each under its own key, with its
 * alarm persisted (normally `storeAlarmPersistence`). After a process restart the embedding host opens its sessions'
 * alarms again; an alarm that fell due meanwhile fires at once.
 */
export interface BunTimerHost {
	/**
	 * The alarm of session `key`, read from `persistence`. Opening a key again replaces the earlier instance: fires go
	 * to the newest `onFire`, and the replaced instance's writes are refused.
	 */
	openAlarm(
		key: string,
		persistence: AlarmPersistence,
		onFire: () => Promise<void>,
		options?: WakeAlarmOptions,
	): Promise<WakeAlarm>;
	/** Cancel every timer. Persisted alarms stay. */
	close(): void;
}

interface Entry {
	at: number | undefined;
	cancel: (() => void) | undefined;
	readonly onFire: () => Promise<void>;
}

const DEFAULT_MAX_DELAY_MS = 60_000;

const defaultSetTimer: SetTimer = (callback, ms) => {
	const handle = setTimeout(callback, ms);
	return () => clearTimeout(handle);
};

export function createBunTimerHost(options: BunTimerHostOptions): BunTimerHost {
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? defaultSetTimer;
	const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const entries = new Map<string, Entry>();
	const delivering = new Set<string>();

	function schedule(key: string, entry: Entry, retry = false): void {
		entry.cancel?.();
		entry.cancel = undefined;
		if (entry.at === undefined || entries.get(key) !== entry || delivering.has(key)) return;
		const delay = retry ? maxDelayMs : Math.min(Math.max(0, entry.at - now()), maxDelayMs);
		entry.cancel = setTimer(() => tick(key, entry), delay);
	}

	async function tick(key: string, entry: Entry): Promise<void> {
		entry.cancel = undefined;
		const firedAt = entry.at;
		if (firedAt === undefined || entries.get(key) !== entry) return;
		if (now() < firedAt) return schedule(key, entry);
		delivering.add(key);
		try {
			await entry.onFire();
		} catch (error) {
			options.onFireError(key, error);
		} finally {
			delivering.delete(key);
			const current = entries.get(key);
			if (current !== undefined) schedule(key, current, current === entry && current.at === firedAt);
		}
	}

	return {
		async openAlarm(key, persistence, onFire, alarmOptions = {}) {
			const entry: Entry = { at: await persistence.read(), cancel: undefined, onFire };
			entries.get(key)?.cancel?.();
			entries.set(key, entry);
			schedule(key, entry);

			const write = async (at: number | undefined): Promise<void> => {
				if (entries.get(key) !== entry) throw new Error(`the alarm instance of ${key} was replaced by a newer one`);
				const point = (stage: "before" | "durable") =>
					alarmOptions.onAlarmPoint?.(
						at === undefined ? { op: "clear", at: stage } : { op: "set", at: stage, time: at },
					);
				point("before");
				await persistence.write(at);
				entry.at = at;
				schedule(key, entry);
				point("durable");
			};
			return { read: () => persistence.read(), set: (at) => write(at), clear: () => write(undefined) };
		},
		close() {
			for (const entry of entries.values()) entry.cancel?.();
			entries.clear();
		},
	};
}
