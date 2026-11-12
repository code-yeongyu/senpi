import { stat } from "node:fs/promises";
import type { FileIdentity } from "./sqlite-file-identity.ts";

export interface OwnershipSafeLockOptions {
	readonly retries?: {
		readonly retries: number;
		readonly minTimeout: number;
		readonly maxTimeout: number;
	};
	/**
	 * The caller's validation of the lock file through its own descriptor (open, fstat, close), returning the identity it
	 * found; SQLite must open exactly that file. It runs before each open attempt, inside the same one-at-a-time section as
	 * the SQLite open (`openExpectedFile`).
	 */
	readonly validateFile?: () => Promise<FileIdentity>;
}

/** The lock file SQLite opened is not the one the caller validated: a lock taken there would serialize nothing. */
export class LockFileReplacedError extends Error {
	readonly code = "ELOCK_FILE_REPLACED" as const;
	readonly lockPath: string;

	constructor(lockPath: string, detail: string) {
		super(`Lock file was not the validated one: ${detail}`);
		this.name = "LockFileReplacedError";
		this.lockPath = lockPath;
	}
}

/**
 * Which file SQLite opened could not be proven (`busy` in sqlite-file-identity.ts), as while another connection of this
 * process has the lock file open. Retried like contention until the deadline, then thrown; each attempt closes its
 * connection first, so no lock is ever taken on a file that was not proven.
 */
export class LockFileBusyError extends Error {
	readonly code = "ELOCK_FILE_BUSY" as const;
	readonly lockPath: string;

	constructor(lockPath: string, detail: string) {
		super(`Lock file could not be proven yet: ${detail}`);
		this.name = "LockFileBusyError";
		this.lockPath = lockPath;
	}
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
async function openLockDatabase(
	lockPath: string,
	validateFile: (() => Promise<FileIdentity>) | undefined,
): Promise<LockDatabase> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const database = await openChecked(
			lockPath,
			validateFile,
			() => new Database(lockPath, { create: true }),
			(opened) => opened.close(false),
		);
		return { exec: (sql) => database.exec(sql), close: () => database.close(false) };
	}
	const { DatabaseSync } = await import("node:sqlite");
	const database = await openChecked(
		lockPath,
		validateFile,
		() => new DatabaseSync(lockPath),
		(opened) => opened.close(),
	);
	return { exec: (sql) => database.exec(sql), close: () => database.close() };
}

/**
 * The identity proof is part of this function's lazy loading boundary, like the SQLite driver above: it loads only when a
 * caller passes `validateFile` (the socket secret's repair lock), so it stays out of the lifecycle supervisor's startup
 * graph, which imports this module (`test/supervisor-import-graph.test.ts`).
 */
async function openChecked<T>(
	lockPath: string,
	validateFile: (() => Promise<FileIdentity>) | undefined,
	open: () => T,
	close: (opened: T) => void,
): Promise<T> {
	if (validateFile === undefined) return open();
	const { openExpectedFile } = await import("./sqlite-file-identity.ts");
	const checked = await openExpectedFile(lockPath, validateFile, open, close);
	if ("replaced" in checked) throw new LockFileReplacedError(lockPath, checked.replaced);
	if ("busy" in checked) throw new LockFileBusyError(lockPath, checked.busy);
	return checked.opened;
}

export async function acquireOwnershipSafeLock(
	lockPath: string,
	options: OwnershipSafeLockOptions = {},
): Promise<() => Promise<void>> {
	const retries = options.retries ?? DEFAULT_RETRIES;
	// One cumulative deadline caps the total wait (proper-lockfile's profile
	// waited ~10s); each SQLite busy wait stays SHORT because it blocks the
	// event loop synchronously - a long busy_timeout would stop a same-process
	// holder from ever finishing its critical section - and the async sleep
	// between attempts yields without adding to the budget (the deadline is the
	// only limit).
	const deadline = Date.now() + retries.retries * retries.maxTimeout;
	while (true) {
		await rejectLegacyDirectory(lockPath);
		const busyMs = Math.max(1, Math.min(retries.maxTimeout, deadline - Date.now()));
		let database: LockDatabase | undefined;
		try {
			database = await openLockDatabase(lockPath, options.validateFile);
			database.exec(`PRAGMA busy_timeout = ${busyMs}; BEGIN EXCLUSIVE;`);
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
			const retryable =
				error instanceof LockFileBusyError || (!(error instanceof LockFileReplacedError) && isBusy(error));
			if (retryable && Date.now() < deadline) {
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

export function isBusy(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /busy|locked/i.test(message) || (error as { code?: string })?.code === "SQLITE_BUSY";
}
