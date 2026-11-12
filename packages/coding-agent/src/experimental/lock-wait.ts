import { type FileLockOptions, type HeldFileLock, lockWithLossHandling } from "../core/file-lock.ts";

/**
 * Acquire errors that end once another holder or the system lets go: the lock is held, or the process or system is
 * briefly out of file descriptors or the path is busy. proper-lockfile's own retry loop retried these; it measures its
 * budget on the wall clock, so the waits below take one attempt at a time on the monotonic clock instead.
 */
const TRANSIENT_ACQUIRE_CODES: ReadonlySet<string> = new Set([
	"ELOCKED",
	"EMFILE",
	"ENFILE",
	"EBUSY",
	"EAGAIN",
	"EINTR",
]);
const LOCK_RETRY_MS = 25;

/**
 * Takes the lock at `path`, retrying held and transient acquire errors until `waitMs` has passed on the monotonic clock;
 * any other error, or the last one once the budget is spent, is thrown.
 */
export async function waitForFileLock(
	path: string,
	options: Omit<FileLockOptions, "retries">,
	waitMs: number,
): Promise<HeldFileLock> {
	const deadline = performance.now() + waitMs;
	while (true) {
		try {
			return await lockWithLossHandling(path, { ...options, retries: 0 });
		} catch (error) {
			const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
			if (code === undefined || !TRANSIENT_ACQUIRE_CODES.has(code) || performance.now() >= deadline) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
}
