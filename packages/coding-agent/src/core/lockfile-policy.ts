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
	// Every acquisition passes retries: 0 and runs its own bounded wait loop below, so an
	// AbortSignal is observed between attempts rather than after the whole budget.
	retries: 0,
} as const;

export const FILE_STORAGE_LOCK_RETRY_BUDGET_MS = 5_500;
export const FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS = 100;
export const FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS = 1_000;
// Sync callers block the TUI main thread, so keep their bounded wait short despite Atomics.wait avoiding CPU spin.
export const FILE_STORAGE_SYNC_LOCK_BUDGET_MS = 1_000;

export class CredentialStoreBusyError extends Error {
	readonly path: string;
	readonly waitedMs: number;

	constructor(path: string, waitedMs: number, cause?: unknown) {
		super(
			`Credential store is busy: lock ${path} was held for ${waitedMs}ms. Another omo process may be refreshing credentials; close unused sessions if contention persists.`,
			{ cause },
		);
		this.name = "CredentialStoreBusyError";
		this.path = path;
		this.waitedMs = waitedMs;
	}
}

export function isLockError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ELOCKED"
	);
}
