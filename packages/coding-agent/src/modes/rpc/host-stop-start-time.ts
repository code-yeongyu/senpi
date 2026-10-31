import { stat } from "node:fs/promises";
import { processStartTimeMs, readProcessStartTime } from "../../utils/process-identity.ts";

/**
 * Whether this platform can record a process start time at registration. On Windows the CIM probe often
 * outlives its 1 s budget while a host starts, so engine hosts record `processStartTime: null` (measured
 * on a Windows runner) and a generation-bound stop cannot compare start times (omo-desktop-app#3561).
 */
export function processStartTimeIsUnreadable(): boolean {
	return process.platform === "win32";
}

/** A stop is an operator action: give the start-time probe the budget a loaded Windows host needs. */
const STOP_START_TIME_BUDGET_MS = 10_000;

/** The live start time of `pid` now, or undefined when the process is gone. Throws when unreadable. */
export function readLiveStartTime(pid: number): Promise<string | undefined> {
	return readProcessStartTime(pid, process.platform, STOP_START_TIME_BUDGET_MS);
}

/**
 * Proves, without a recorded start time, that `pid` is still the process that wrote `registrationFile`:
 * that process started before it wrote the file, so a live start time LATER than the file's mtime is a
 * reused pid. Gone, unreadable or unparseable is not proven.
 */
export async function startedBeforeRegistration(pid: number, registrationFile: string): Promise<boolean> {
	const live = await readLiveStartTime(pid).catch(() => undefined);
	const startedMs = live === undefined ? undefined : processStartTimeMs(live);
	if (startedMs === undefined) return false;
	const written = await stat(registrationFile).catch(() => undefined);
	return written !== undefined && startedMs <= written.mtimeMs;
}
