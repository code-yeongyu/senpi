/**
 * The WakeHost contract of the durable core (packages/agent/docs/durable-core-adr.md): wake ordering for hosts that can
 * be evicted (a Durable Object) or put to sleep (a laptop). A process timer is lost with its host and runs late across
 * a sleep, so the host keeps a durable alarm and follows one ordering, shared by every host here:
 *
 * - admit: arm a recovery heartbeat durably BEFORE work that can commit starts. A commit whose host dies before the
 *   alarm update would otherwise strand its wake; an early alarm is harmless, a missing one loses work. The host counts
 *   admissions in flight and arms as active while any is, so no concurrent update or fire can clear that heartbeat
 *   before the admitted work commits; when the last admitted work succeeds, it arms from the loop's wake.
 * - update: after each commit, arm min(heartbeat if active, the loop's earliest wake); clear only when idle.
 * - fire: re-arm the heartbeat before resuming, so a resume that dies is retried; then arm from the loop's wake.
 * - start (a new instance): arm a fallback before anything can throw, then resume what a lost instance left.
 *
 * Timers inside the loop are not the WakeHost's. Where a host can neither be evicted nor sleep it reduces to a timer.
 */

/** The loop's wake state: `active` while some work can run now or is running; `at`, the earliest later wake. */
export interface Wake {
	readonly active: boolean;
	readonly at?: number;
}

/** A host's durable alarm for one session; the armed time (epoch ms) survives instance loss and host restarts. */
export interface WakeAlarm {
	read(): Promise<number | undefined>;
	set(at: number): Promise<void>;
	clear(): Promise<void>;
}

/** A point inside an alarm write. `before`: nothing is durable yet. `durable`: the write is durable. */
export type WakeAlarmPoint =
	| { readonly op: "set"; readonly at: "before" | "durable"; readonly time: number }
	| { readonly op: "clear"; readonly at: "before" | "durable"; readonly time?: undefined };

export interface WakeAlarmOptions {
	/** Test seam for cuts and kills: a throw at `before` leaves the alarm unchanged, at `durable` leaves it written. */
	readonly onAlarmPoint?: (point: WakeAlarmPoint) => void;
}

/** The point after an operation's arm is durable and before its work (`admit`) or resume (`start`, `fire`) runs. */
export interface WakePoint {
	readonly op: "start" | "admit" | "fire";
	readonly at: "armed";
}

export interface WakeHostOptions {
	readonly alarm: WakeAlarm;
	/** The host clock, epoch milliseconds; the same clock the loop's wake times use. */
	readonly now: () => number;
	readonly wake: () => Wake;
	/** Run what the loop can run now: due wakes and work a lost instance left. Resolves when it has. */
	readonly resume: () => Promise<void>;
	/** The recovery interval while work is active or admitted. Default 60 s. */
	readonly heartbeatMs?: number;
	/** Test seam for kills between an arm and the work it protects. */
	readonly onWakePoint?: (point: WakePoint) => void;
}

export interface WakeHost {
	/** A new instance: arm a fallback, resume, then arm from the loop's wake. */
	start(): Promise<void>;
	/** Run work that can commit, after a recovery heartbeat is durable. */
	admit<T>(work: () => Promise<T>): Promise<T>;
	update(wake: Wake): Promise<void>;
	/** The alarm fired: re-arm the heartbeat, resume, then arm from the loop's wake. */
	fire(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 60_000;

/** The alarm time for a wake state: a heartbeat while active, never later than the earliest wake. */
function recoveryAlarmAt(wake: Wake, now: number, heartbeatMs: number): number | undefined {
	const heartbeat = wake.active ? now + heartbeatMs : undefined;
	if (heartbeat === undefined) return wake.at;
	return wake.at === undefined ? heartbeat : Math.min(heartbeat, wake.at);
}

export function createWakeHost(options: WakeHostOptions): WakeHost {
	const { alarm, now, wake, resume } = options;
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	const point = (op: WakePoint["op"]): void => options.onWakePoint?.({ op, at: "armed" });

	let admitted = 0;

	const arm = async (state: Wake): Promise<void> => {
		const at = recoveryAlarmAt(admitted > 0 ? { ...state, active: true } : state, now(), heartbeatMs);
		if (at === undefined) await alarm.clear();
		else await alarm.set(at);
	};

	return {
		async start() {
			const fallback = now() + heartbeatMs;
			const current = await alarm.read();
			if (current === undefined || current > fallback) await alarm.set(fallback);
			point("start");
			await resume();
			await arm(wake());
		},
		async admit<T>(work: () => Promise<T>): Promise<T> {
			admitted++;
			let result: T;
			try {
				await arm({ ...wake(), active: true });
				point("admit");
				result = await work();
			} finally {
				admitted--;
			}
			if (admitted === 0) await arm(wake());
			return result;
		},
		update: (state) => arm(state),
		async fire() {
			await arm({ ...wake(), active: true });
			point("fire");
			await resume();
			await arm(wake());
		},
	};
}
