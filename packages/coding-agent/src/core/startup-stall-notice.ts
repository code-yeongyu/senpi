import type { TimedPhase } from "./timings.ts";

/**
 * senpi#7556: a stdio RPC engine whose client gave up after seeing 0 bytes left no trace of where startup stood.
 * While startup is unfinished past the deadline, this writes one stderr line per interval naming the last phase
 * `time()` closed, so the next silent launch names its blocking step instead of guessing at it.
 */

/** Time source and timer for the notice; production uses `performance.now()` and an unref'd `setTimeout`. */
export interface StartupStallClock {
	now(): number;
	/** Runs `callback` after `delayMs`; the returned function cancels it. */
	schedule(callback: () => void, delayMs: number): () => void;
}

export interface StartupStallNoticeOptions {
	readonly deadlineMs: number;
	/** Line prefix, e.g. `senpi rpc`. */
	readonly label: string;
	readonly lastPhase: () => TimedPhase | undefined;
	readonly write: (line: string) => void;
	readonly clock?: StartupStallClock;
}

export interface StartupStallNotice {
	/** Startup finished: no further notice is written. */
	ready(): void;
}

/** Below the 15 s a client such as an editor's status probe waits for its first answer, so the line lands first. */
export const RPC_STARTUP_STALL_DEADLINE_MS = 10_000;

const realClock: StartupStallClock = {
	now: () => performance.now(),
	schedule: (callback, delayMs) => {
		// Unref'd: a notice must never be what keeps a finished or exiting process alive.
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

const seconds = (ms: number, digits: number): string => (ms / 1000).toFixed(digits);

export function armStartupStallNotice(options: StartupStallNoticeOptions): StartupStallNotice {
	const clock = options.clock ?? realClock;
	const armedAt = clock.now();
	let cancel = (): void => {};
	const fire = (): void => {
		const now = clock.now();
		const phase = options.lastPhase();
		const where =
			phase === undefined
				? "no startup phase has completed yet"
				: `last completed phase: ${phase.label} (${seconds(now - phase.atMs, 1)}s ago)`;
		options.write(`${options.label}: startup has not finished after ${seconds(now - armedAt, 0)}s; ${where}\n`);
		cancel = clock.schedule(fire, options.deadlineMs);
	};
	cancel = clock.schedule(fire, options.deadlineMs);
	return { ready: () => cancel() };
}

/** A single-session stdio RPC launch (`--mode rpc` / `--mode=rpc`); a `--multi-session` host serves sockets instead. */
export function isStdioRpcLaunch(args: readonly string[]): boolean {
	if (args.includes("--multi-session")) return false;
	return args.some((arg, index) => arg === "--mode=rpc" || (arg === "--mode" && args[index + 1] === "rpc"));
}
