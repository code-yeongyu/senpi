/**
 * Contention on the endpoint reservation store (sisyphuslabs/omo-desktop-app#4199). SQLite's own busy wait
 * (`busy_timeout`) blocks the event loop, so the store keeps it short and refuses with `store_busy`; a caller that
 * should wait longer retries through `retryWhenBusy`, which waits asynchronously between attempts.
 */
import { EndpointReservationError } from "./endpoint-reservation-error.ts";

/**
 * SQLite contention: the primary result code SQLITE_BUSY (5) or SQLITE_LOCKED (6), read from node:sqlite's `errcode`
 * or a runtime's `SQLITE_BUSY*`/`SQLITE_LOCKED*` code; the message is consulted only when the error carries neither.
 */
export function isBusy(error: unknown): boolean {
	const errcode = typeof error === "object" && error !== null ? Reflect.get(error, "errcode") : undefined;
	if (typeof errcode === "number") return (errcode & 0xff) === 5 || (errcode & 0xff) === 6;
	const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
	if (typeof code === "string" && code.startsWith("SQLITE_")) return /^SQLITE_(BUSY|LOCKED)/.test(code);
	return /database is (locked|busy)|database table is locked/i.test(
		error instanceof Error ? error.message : String(error),
	);
}

export interface StoreBusyPolicy {
	/** Attempts in all, the first included. */
	readonly attempts: number;
	/** Waits after the failed attempt `attempt`; asynchronous, so a holder in this process can finish meanwhile. */
	readonly wait: (attempt: number) => Promise<void>;
}

// 20 attempts with waits growing from 10 ms to 100 ms: about 1.5 s of waiting plus each attempt's short busy_timeout.
const DEFAULT_BUSY_POLICY: StoreBusyPolicy = {
	attempts: 20,
	wait: (attempt) => new Promise((resolve) => setTimeout(resolve, Math.min(10 * attempt, 100))),
};

/**
 * Runs `run` again while it is refused as `store_busy`, at most `policy.attempts` times in all, and then refuses with
 * `store_busy` (the last refusal as its cause). Every other outcome passes through at once, so a domain refusal is never
 * retried. Rerunning is safe: a transition refused as `store_busy` kept nothing, since its BEGIN or COMMIT found the
 * store busy and it was rolled back.
 */
export async function retryWhenBusy<T>(
	run: () => T | Promise<T>,
	policy: StoreBusyPolicy = DEFAULT_BUSY_POLICY,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error: unknown) {
			if (!(error instanceof EndpointReservationError) || error.reason !== "store_busy") throw error;
			if (attempt >= policy.attempts) {
				throw new EndpointReservationError("store_busy", `still held after ${attempt} attempts`, { cause: error });
			}
			await policy.wait(attempt);
		}
	}
}
