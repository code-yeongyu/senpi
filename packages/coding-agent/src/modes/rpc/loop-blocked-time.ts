/**
 * Process-wide ledger of time the host event loop spent blocked.
 *
 * The loop-lag watchdog deposits every measured drift here; a deadline that must count
 * only loop-SERVED time (the socket dead-peer detector) takes a mark when it arms and
 * asks how much blocked time landed since. Kept import-free so both sides can read it
 * without a cycle.
 */
let blockedMsTotal = 0;

export function recordLoopBlockedMs(driftMs: number): void {
	if (driftMs > 0) blockedMsTotal += driftMs;
}

export function loopBlockedMark(): number {
	return blockedMsTotal;
}

export function loopBlockedMsSince(mark: number): number {
	return blockedMsTotal - mark;
}
