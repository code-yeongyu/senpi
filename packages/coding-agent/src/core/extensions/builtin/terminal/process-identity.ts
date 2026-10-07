import { uptime as osUptimeSeconds } from "node:os";

/**
 * Two boot instants further apart than this belong to different boots. `os.uptime()` is
 * integral seconds on every platform, and a laptop's sleep is accounted in uptime, so the
 * only drift left is sub-second rounding on either side.
 */
export const BOOT_INSTANT_TOLERANCE_MS = 120_000;

/** Two process start instants further apart than this are different processes (ps/lstart is second-precise). */
export const PROCESS_START_TOLERANCE_MS = 3_000;

const wholeSeconds = (ms: number): number => Math.round(ms / 1000) * 1000;

export function processBootAtMs(now: () => number = Date.now): number {
	return wholeSeconds(now() - osUptimeSeconds() * 1000);
}

const floorToSecond = (ms: number): number => Math.floor(ms / 1000) * 1000;

/**
 * Captured once at load: `process.uptime()` runs on a monotonic clock that stops during a Linux
 * suspend, so recomputing later would drift by every suspend and read our own live lease as reused.
 */
const OWN_START_AT_LOAD = floorToSecond(Date.now() - process.uptime() * 1000);

/** Floored like `ps -o lstart`, which truncates to the second: rounding up could land after now. */
export function ownProcessStartedAtMs(now?: () => number): number {
	return now === undefined ? OWN_START_AT_LOAD : floorToSecond(now() - process.uptime() * 1000);
}

export function sameBoot(bootAtMs: number, otherBootAtMs: number | undefined): boolean {
	if (otherBootAtMs === undefined || !Number.isFinite(otherBootAtMs)) return false;
	return Math.abs(bootAtMs - otherBootAtMs) <= BOOT_INSTANT_TOLERANCE_MS;
}

export function sameProcessStart(startedAtMs: number, otherStartedAtMs: number | undefined): boolean {
	if (otherStartedAtMs === undefined || !Number.isFinite(otherStartedAtMs)) return false;
	return Math.abs(startedAtMs - otherStartedAtMs) <= PROCESS_START_TOLERANCE_MS;
}

export interface ChildProcessIdentity {
	readonly pid: number;
	readonly processGroupId?: number;
	readonly startedAtMs: number;
	readonly bootAtMs: number;
	readonly argv: readonly string[];
}
