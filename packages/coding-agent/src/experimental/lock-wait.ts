import { type FileLockOptions, type HeldFileLock, lockWithLossHandling } from "../core/file-lock.ts";

/**
 * Acquire errors that end once the system lets go: the process or system is briefly out of file descriptors, or the
 * path is busy. proper-lockfile's own retry loop retried these and a held lock; it measures its budget on the wall
 * clock, so the waits below take one attempt at a time on the monotonic clock instead.
 */
const TRANSIENT_ACQUIRE_CODES: ReadonlySet<string> = new Set(["EMFILE", "ENFILE", "EBUSY", "EAGAIN", "EINTR"]);
const LOCK_RETRY_MS = 25;

export interface LockWaitBounds {
	/**
	 * How long a lock another process holds is waited for. A holder refreshes its lock while it lives, and a lock that
	 * goes unrefreshed past its staleness bound is taken over, so `Infinity` waits exactly as long as the holder lives.
	 */
	readonly heldMs: number;
	/** How long transient acquire errors are retried. */
	readonly transientMs: number;
}

/** Takes the lock at `path`; any other error, or the last one once its bound has passed, is thrown. */
export async function waitForFileLock(
	path: string,
	options: Omit<FileLockOptions, "retries">,
	bounds: LockWaitBounds,
): Promise<HeldFileLock> {
	const started = performance.now();
	while (true) {
		try {
			return await lockWithLossHandling(path, { ...options, retries: 0 });
		} catch (error) {
			const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
			const bound =
				code === "ELOCKED"
					? bounds.heldMs
					: code !== undefined && TRANSIENT_ACQUIRE_CODES.has(code)
						? bounds.transientMs
						: 0;
			if (performance.now() - started >= bound) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
}
