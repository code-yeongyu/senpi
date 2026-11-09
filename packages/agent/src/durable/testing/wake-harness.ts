import type { DurableStore, DurableStoreOptions, StoreWritePoint } from "../store.ts";
import {
	createWakeHost,
	type WakeAlarm,
	type WakeAlarmOptions,
	type WakeAlarmPoint,
	type WakeHost,
	type WakePoint,
} from "../wake-host.ts";
import type { StoreCaseAdapters } from "./store-harness.ts";
import { openTestLoop, type TestLoop } from "./wake-test-loop.ts";

/** The session a host's alarm belongs to. Hosts that persist the alarm in the store use `store` under `epoch`. */
export interface WakeAlarmSession {
	readonly medium: string;
	readonly store: DurableStore;
	readonly epoch: number;
	readonly onFire: () => Promise<void>;
	readonly options?: WakeAlarmOptions;
}

/** What a host provides to the WAKE, KILL-WAKE and MULTI-HOST cases, next to its store adapter. */
export interface WakeConformanceAdapter {
	/** The host clock, epoch milliseconds; only `advanceTo` moves it. */
	now(): number;
	/** Move the clock to `at`, delivering every alarm that falls due on the way, in time order, each awaited. */
	advanceTo(at: number): Promise<void>;
	/**
	 * The durable alarm of one session. Opening it again (a new instance after a kill) replaces the earlier instance:
	 * fires go to the newest `onFire` only. The armed time outlives instances and host restarts.
	 */
	openAlarm(session: WakeAlarmSession): Promise<WakeAlarm>;
	/** The host process restarts: instances and in-memory timers are lost, durable alarms are kept. */
	restart(): Promise<void>;
}

export interface WakeCaseAdapters extends StoreCaseAdapters {
	readonly wake: WakeConformanceAdapter;
}

export const HEARTBEAT_MS = 60_000;

/** A simulated kill inside a wake case; every cut in these cases throws it. */
class WakeCut extends Error {
	constructor(where: string) {
		super(`cut at ${where}`);
		this.name = "WakeCut";
	}
}

const isCut = (error: unknown): boolean => error instanceof WakeCut;

/** Throw a WakeCut the `nth` time `matches` sees a point (1-based). */
function cutNth<P>(matches: (point: P) => boolean, nth: number): (point: P) => void {
	let seen = 0;
	return (point) => {
		if (matches(point) && ++seen === nth) throw new WakeCut(JSON.stringify(point));
	};
}

export const cutStore = (op: StoreWritePoint["op"], at: StoreWritePoint["at"], nth = 1): DurableStoreOptions => ({
	onWritePoint: cutNth<StoreWritePoint>((point) => point.op === op && point.at === at, nth),
});

export const cutAlarm = (op: WakeAlarmPoint["op"], at: WakeAlarmPoint["at"], nth = 1): WakeAlarmOptions => ({
	onAlarmPoint: cutNth<WakeAlarmPoint>((point) => point.op === op && point.at === at, nth),
});

export const cutWake = (op: WakePoint["op"], nth = 1): ((point: WakePoint) => void) =>
	cutNth<WakePoint>((point) => point.op === op, nth);

export async function expectWakeCut(operation: Promise<unknown>, what: string): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (isCut(error)) return;
		throw new Error(`${what}: expected the cut to surface, got ${String(error)}`);
	}
	throw new Error(`${what}: expected the cut to surface, but it resolved`);
}

export interface SessionInstance {
	readonly loop: TestLoop;
	readonly host: WakeHost;
}

export interface BootOptions {
	readonly store?: DurableStoreOptions;
	readonly alarm?: WakeAlarmOptions;
	readonly onWakePoint?: (point: WakePoint) => void;
}

/** One session on the host: its medium, its live instance (if any), and what the cases observe. */
export interface SessionSlot {
	/** The clock time the slot was created at; trace times are relative to it. */
	readonly base: number;
	/** Durable alarm writes (`set:+ms` / `clear`) and `resume` calls, in order, across instances. */
	readonly trace: string[];
	/** The live instance; with none, boot one (open + `start`) with `options`. */
	instance(options?: BootOptions): Promise<SessionInstance>;
	/** Drop the live instance, as an eviction or crash does. */
	kill(): void;
	/** Alarm fires delivered to this session. */
	fires(): number;
	/** Task IDs the loop committed as run, in commit order. */
	ran(): Promise<string[]>;
	/** The durable alarm, relative to `base`; undefined when cleared. */
	alarmAt(): Promise<number | undefined>;
}

export async function createSlot(adapters: WakeCaseAdapters, epoch = 1): Promise<SessionSlot> {
	const { store: storeAdapter, wake } = adapters;
	const medium = await storeAdapter.createMedium();
	const reader = await storeAdapter.open(medium);
	for (let next = 1; next <= epoch; next++) await reader.claim(next - 1, next);
	const base = wake.now();
	const trace: string[] = [];
	let live: SessionInstance | undefined;
	let alarm: WakeAlarm | undefined;
	let fires = 0;

	const record = (options: WakeAlarmOptions | undefined): WakeAlarmOptions => ({
		onAlarmPoint: (point) => {
			options?.onAlarmPoint?.(point);
			if (point.at === "durable") trace.push(point.op === "clear" ? "clear" : `set:+${(point.time ?? 0) - base}`);
		},
	});

	async function boot(options: BootOptions = {}): Promise<SessionInstance> {
		const store = await storeAdapter.open(medium, options.store);
		let host: WakeHost | undefined;
		const loop = await openTestLoop(store, epoch, wake.now, async () => host?.update(loop.wake()));
		alarm = await wake.openAlarm({
			medium,
			store: await storeAdapter.open(medium),
			epoch,
			onFire: dispatch,
			options: record(options.alarm),
		});
		host = createWakeHost({
			alarm,
			now: wake.now,
			wake: () => loop.wake(),
			resume: async () => {
				trace.push("resume");
				await loop.resume();
			},
			heartbeatMs: HEARTBEAT_MS,
			onWakePoint: options.onWakePoint,
		});
		const instance = { loop, host };
		live = instance;
		await host.start();
		return instance;
	}

	async function dispatch(): Promise<void> {
		fires++;
		try {
			const instance = live ?? (await boot());
			await instance.host.fire();
		} catch (error) {
			if (!isCut(error)) throw error;
			live = undefined;
		}
	}

	return {
		base,
		trace,
		async instance(options) {
			if (live !== undefined) return live;
			try {
				return await boot(options);
			} catch (error) {
				if (isCut(error)) live = undefined;
				throw error;
			}
		},
		kill: () => {
			live = undefined;
		},
		fires: () => fires,
		ran: async () => (await reader.scanRecords({ kind: "ran" })).map((record) => record.id.slice("ran:".length)),
		alarmAt: async () => {
			const at = await alarm?.read();
			return at === undefined ? undefined : at - base;
		},
	};
}

/** Restart the host process: every slot loses its live instance; durable state stays. */
export async function restartHost(adapters: WakeCaseAdapters, slots: readonly SessionSlot[]): Promise<void> {
	await adapters.wake.restart();
	for (const slot of slots) slot.kill();
}
