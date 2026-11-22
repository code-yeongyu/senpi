/**
 * The recorded-supervisor poll (senpi#3795): a free liveness check every tick and, rarely, the recorded start compared
 * on one clock per platform. It is the host's only binding when no event binding exists, a backup cadence beside an
 * inherited pipe (senpi#3738), and a single long backstop beside an event binding. Split out of host-watchdog.ts.
 */
import { readProcessStartTime } from "../../utils/process-identity.ts";
import { compareRecordedStart, readProcessStartTicks } from "../../utils/process-start-identity.ts";

/** While an event binding (lifetime FIFO or reopened stdin) is armed, the identity check is one long backstop. */
export const HOST_WATCH_BACKSTOP_INTERVAL_MS = 30_000;
/** Poll cadence for the recorded-supervisor poll when it is the only binding. */
export const HOST_WATCH_PPID_INTERVAL_MS = 250;
/**
 * Poll cadence for the ppid check while the inherited pipe is armed (senpi#3738). EOF on the pipe is
 * the primary signal and arrives from kqueue/epoll at once; the ppid check then only backs it up, so
 * an idle host does not wake four times a second for a signal the pipe already delivers.
 */
export const HOST_WATCH_PPID_BACKUP_INTERVAL_MS = 5_000;
/**
 * How often the recorded supervisor's start is compared (senpi#3816 review). The liveness check runs every tick and
 * catches a dead supervisor (ESRCH); its pid can only be reused after that death, so the start comparison only has to
 * catch a death between ticks and runs rarely: every 5 s on Linux (`/proc` start ticks, nothing spawned), every 60 s
 * elsewhere (`ps`), so an idle host spawns no processes (senpi#3738). Counted in ticks, so no clock step moves it.
 */
export const HOST_WATCH_IDENTITY_INTERVAL_MS = 5_000;
/**
 * Liveness cadence when the recorded supervisor identity is the host's ONLY binding (senpi#3816 review, senpi#3738):
 * on Linux a supervised host has no stdin lifetime fd and no slot 3. One free `kill(pid, 0)` a second; supervisor
 * death is then noticed within about a second instead of 250 ms, for a quarter of the idle wakeups.
 */
export const HOST_WATCH_IDENTITY_ONLY_INTERVAL_MS = 1_000;
export const HOST_WATCH_SPAWNING_IDENTITY_INTERVAL_MS = 60_000;
export interface SupervisorPoll {
	/** (Re)arms the poll at `intervalMs`; a no-op when already at that cadence or when there is no supervisor pid. */
	arm(intervalMs: number): void;
	/** The cadence when the poll is the host's only binding: identity-only (1 s) with a recorded start, else 250 ms. */
	readonly soleInterval: number;
	stop(): void;
}

export function supervisorPoll(
	ppid: number | undefined,
	recorded: { readonly ticks?: string; readonly time?: string },
	fire: (reason: string) => void,
	stopped: () => boolean,
): SupervisorPoll {
	let stopPpid: (() => void) | undefined;
	let ppidIntervalMs: number | undefined;
	return {
		arm(intervalMs) {
			if (stopped() || ppid === undefined || ppidIntervalMs === intervalMs) return;
			stopPpid?.();
			ppidIntervalMs = intervalMs;
			stopPpid = watchPpid(ppid, recorded, fire, intervalMs);
		},
		soleInterval:
			recorded.ticks !== undefined || recorded.time !== undefined
				? HOST_WATCH_IDENTITY_ONLY_INTERVAL_MS
				: HOST_WATCH_PPID_INTERVAL_MS,
		stop: () => stopPpid?.(),
	};
}

/**
 * Poll only the recorded supervisor, never process.ppid (a wrapper may be the parent). Every tick is a free
 * `kill(pid, 0)`: ESRCH is death. The recorded start is compared rarely, on one clock per platform
 * (`compareRecordedStart`); only an observed change is death, and an unreadable or missing identity is unknown.
 */
function watchPpid(
	supervisorPid: number,
	recorded: { readonly ticks?: string; readonly time?: string },
	fire: (reason: string) => void,
	intervalMs: number,
): () => void {
	// Tests and embedders may bind the watchdog to this process itself; that
	// is a valid live binding rather than evidence of supervisor loss.
	if (supervisorPid === process.pid) return () => {};
	const linux = process.platform === "linux";
	const comparable = linux ? recorded.ticks !== undefined : recorded.time !== undefined;
	const identityEveryTicks = Math.max(
		1,
		Math.round((linux ? HOST_WATCH_IDENTITY_INTERVAL_MS : HOST_WATCH_SPAWNING_IDENTITY_INTERVAL_MS) / intervalMs),
	);
	const probe = {
		ticks: (pid: number) => readProcessStartTicks(pid),
		time: (pid: number) => readProcessStartTime(pid, process.platform, 1000),
	};
	let ticks = 0;
	let stopped = false;
	let probing = false;
	const timer = setInterval(() => {
		if (stopped) return;
		if (!processAlive(supervisorPid)) {
			fire(`supervisor pid ${supervisorPid} is gone`);
			return;
		}
		ticks += 1;
		if (!comparable || probing || ticks % identityEveryTicks !== 0) return;
		probing = true;
		void compareRecordedStart(supervisorPid, recorded, process.platform, probe)
			.then(
				(result) => {
					if (!stopped && result === "changed") fire(`supervisor pid ${supervisorPid} start time changed`);
				},
				// Permission, timeout and probe failures are unknown, never death.
				() => {},
			)
			.finally(() => {
				probing = false;
			});
	}, intervalMs);
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
	}
}
