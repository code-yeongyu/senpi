import { stat } from "node:fs/promises";

export interface OwnershipSafeLockOptions {
	readonly retries?: {
		readonly retries: number;
		readonly minTimeout: number;
		readonly maxTimeout: number;
	};
}

export class LegacyLockArtifactError extends Error {
	readonly code = "ELEGACY_LOCK_ARTIFACT" as const;
	readonly lockPath: string;

	constructor(lockPath: string) {
		super(`Legacy lock directory is present at ${lockPath}`);
		this.name = "LegacyLockArtifactError";
		this.lockPath = lockPath;
	}
}

const DEFAULT_RETRIES = { retries: 100, minTimeout: 20, maxTimeout: 100 } as const;

interface LockDatabase {
	exec(sql: string): void;
	close(): void;
}

/** Runs under both supported runtimes: bun:sqlite inside the Bun binary and
node:sqlite for npm-installed Node executions. Both drive the same kernel
advisory locks on the same file, so cross-runtime contenders exclude each
other (verified empirically; see the changes.md entry). */
async function openLockDatabase(lockPath: string): Promise<LockDatabase> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const database = new Database(lockPath, { create: true });
		return { exec: (sql) => database.exec(sql), close: () => database.close(false) };
	}
	const { DatabaseSync } = await import("node:sqlite");
	const database = new DatabaseSync(lockPath);
	return { exec: (sql) => database.exec(sql), close: () => database.close() };
}

export async function acquireOwnershipSafeLock(
	lockPath: string,
	options: OwnershipSafeLockOptions = {},
): Promise<() => Promise<void>> {
	const retries = options.retries ?? DEFAULT_RETRIES;
	// SQLite busy waits block the event loop, multiplying the stall for each
	// same-process contender. Fail immediately and use only async backoff;
	// the cumulative deadline still caps the total wait.
	const deadline = Date.now() + retries.retries * retries.maxTimeout;
	while (true) {
		await rejectLegacyDirectory(lockPath);
		let database: LockDatabase | undefined;
		try {
			database = await openLockDatabase(lockPath);
			database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
			let released = false;
			const held = database;
			return async () => {
				if (released) return;
				released = true;
				try {
					held.exec("COMMIT;");
				} finally {
					held.close();
				}
			};
		} catch (error: unknown) {
			try {
				database?.close();
			} catch {
				// The connection may already be unusable; the throw below carries the cause.
			}
			// A directory can appear between the stat guard and the open; surface
			// it as the typed legacy error instead of a raw SQLITE_CANTOPEN.
			await rejectLegacyDirectory(lockPath);
			if (isBusy(error) && Date.now() < deadline) {
				await new Promise((resolve) =>
					setTimeout(resolve, Math.min(retries.minTimeout, Math.max(1, deadline - Date.now()))),
				);
				continue;
			}
			throw error;
		}
	}
}

async function rejectLegacyDirectory(lockPath: string): Promise<void> {
	try {
		if ((await stat(lockPath)).isDirectory()) throw new LegacyLockArtifactError(lockPath);
	} catch (error: unknown) {
		if (error instanceof LegacyLockArtifactError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function isBusy(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /busy|locked/i.test(message) || (error as { code?: string })?.code === "SQLITE_BUSY";
}
