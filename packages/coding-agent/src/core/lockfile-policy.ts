/**
 * Shared proper-lockfile acquisition policy for the file-backed auth and settings stores.
 *
 * proper-lockfile defaults to `stale: 10_000` and refreshes a held lock's mtime every
 * `stale / 2` ms (clamped to at least 1s). A sync contender using the default window can
 * therefore classify a live async lock (mtime refreshed every 15s at stale 30s) as stale in
 * the 10-15s gap and steal it. Every store acquires locks with this one policy so that no
 * contender can out-vote a live holder.
 */
export const FILE_STORAGE_LOCK_OPTIONS = {
	realpath: false,
	stale: 30_000,
	update: 10_000,
} as const;
