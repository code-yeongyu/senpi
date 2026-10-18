/**
 * The `abort { awaitIdle }` grace window, shared by the host that enforces it and the client that sizes its
 * request deadline from it (docs/rpc.md `abort`). Kept free of host imports so the client can load it.
 */
export const ABORT_DEFAULT_GRACE_MS = 10_000;
export const ABORT_MAX_GRACE_MS = 60_000;

/** A `graceMs` the host accepts: a whole number of milliseconds from 0 to {@link ABORT_MAX_GRACE_MS}. */
export function isAbortGraceInRange(graceMs: unknown): graceMs is number {
	return typeof graceMs === "number" && Number.isInteger(graceMs) && graceMs >= 0 && graceMs <= ABORT_MAX_GRACE_MS;
}
