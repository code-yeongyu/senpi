import { loadavg } from "node:os";
export interface SettleOptions {
	readonly read?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly intervalMs?: number;
	readonly timeoutMs?: number;
	readonly log?: (line: string) => void;
}

// A referenced timer: while a discarded block waits, nothing else may be keeping the process alive.
const realSleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Waits until the 1-minute load average is at or under `ceiling`. The average decays over about a minute, so
 * re-running a block straight after a spike only meets the same spike again. Returns false on timeout; the caller
 * still runs the attempt, which the per-block guard then judges as usual.
 */
export async function waitForLoadBelow(ceiling: number, options: SettleOptions = {}): Promise<boolean> {
	const read = options.read ?? (() => loadavg()[0] ?? 0);
	const sleep = options.sleep ?? realSleep;
	const intervalMs = options.intervalMs ?? 5_000;
	const timeoutMs = options.timeoutMs ?? 15 * 60_000;
	for (let waited = 0; ; waited += intervalMs) {
		const load = read();
		if (load <= ceiling) return true;
		if (waited >= timeoutMs) {
			options.log?.(`host load ${load.toFixed(2)} still over ${ceiling} after ${Math.round(waited / 1000)} s; retrying anyway`);
			return false;
		}
		await sleep(intervalMs);
	}
}
