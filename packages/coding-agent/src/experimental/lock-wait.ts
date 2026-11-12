import { rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
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
	/**
	 * A marker file a holder keeps inside its lock directory. proper-lockfile removes a lock with a non-recursive
	 * `rmdir`, so a dead holder's marker makes the takeover of its stale lock fail with ENOTEMPTY; the waiter then
	 * removes that one file - only once the lock is older than `staleMs` - and tries again.
	 */
	readonly marker?: { readonly name: string; readonly staleMs: number };
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
			// proper-lockfile removes a stale lock with a non-recursive rmdir, so a dead holder's marker makes its
			// takeover fail with ENOTEMPTY; that one file is removed here and the attempt repeated.
			if (code === "ENOTEMPTY" && bounds.marker !== undefined && (await clearStaleMarker(path, bounds.marker)))
				continue;
			const bound =
				code === "ELOCKED"
					? bounds.heldMs
					: // Two waiters racing one dead lock: the loser's own rmdir hits ENOTEMPTY once the winner has already
						// cleared the marker or taken the lock, and nothing is left for `clearStaleMarker` to remove; or the
						// other's takeover, judged on the old lock, removes the directory this attempt had just created before
						// proper-lockfile's own probe of it (ENOENT). Either is another process making progress, not a broken
						// lock, so both are retried like any transient code.
						code !== undefined && (TRANSIENT_ACQUIRE_CODES.has(code) || code === "ENOTEMPTY" || code === "ENOENT")
						? bounds.transientMs
						: 0;
			if (performance.now() - started >= bound) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
}

async function clearStaleMarker(
	path: string,
	marker: { readonly name: string; readonly staleMs: number },
): Promise<boolean> {
	const lockDirectory = `${path}.lock`;
	const entry = await stat(lockDirectory).catch(() => undefined);
	if (entry === undefined || entry.mtimeMs > Date.now() - marker.staleMs) return false;
	const markerPath = join(lockDirectory, marker.name);
	// Only a marker that was really there counts as progress, so a lock held for another reason cannot spin here.
	if ((await stat(markerPath).catch(() => undefined)) === undefined) return false;
	await rm(markerPath, { force: true });
	// Removing an entry bumps the directory's own mtime, which would make this dead lock look freshly refreshed and
	// turn the takeover into a wait; its staleness is put back so proper-lockfile still sees it as stale.
	await utimes(lockDirectory, entry.atime, entry.mtime).catch(() => {});
	return true;
}
