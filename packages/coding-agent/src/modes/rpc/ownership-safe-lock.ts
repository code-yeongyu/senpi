import { stat } from "node:fs/promises";
import type { FileIdentity } from "./sqlite-file-identity.ts";

export interface OwnershipSafeLockOptions {
	readonly retries?: {
		readonly retries: number;
		readonly minTimeout: number;
		readonly maxTimeout: number;
	};
	/**
	 * The caller's validation of the lock file, returning the identity it found; SQLite must open exactly that file. It
	 * runs before each open attempt, after this process's earlier holders of the lock released it (`inProcessHolders`),
	 * inside the same one-at-a-time section as the SQLite open (`openExpectedFile`). It must not open an existing lock file
	 * (closing that descriptor would drop this process's locks on it) and must not block.
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

/**
 * The lock holders of this process that validate their lock file (`validateFile`), per lock path, in arrival order:
 * each link settles once its holder released the lock or gave up. Closing any descriptor of a file drops all of this
 * process's POSIX locks on it (senpi#6478), so while one of them holds the lock no other one of this process validates
 * or opens the file: the next one waits here, without an attempt of its own, until the lock is released or its deadline
 * passes. The other callers never touch their lock file outside SQLite, whose own connections keep this process's
 * locks (a connection closed while they are held parks its descriptor).
 */
const inProcessHolders = new Map<string, Promise<void>>();

/** An in-process holder still held the lock at the deadline; no attempt was made on the file. Busy, like contention. */
class LockWaitTimeoutError extends Error {
	readonly code = "ELOCK_WAIT_TIMEOUT" as const;
	readonly lockPath: string;

	constructor(lockPath: string) {
		super(`Lock is still held in this process at the deadline: ${lockPath}`);
		this.name = "LockWaitTimeoutError";
		this.lockPath = lockPath;
	}
}

/** Waits for this caller's turn at `lockPath` until `deadline`; answers how to give the turn to the next caller. */
async function waitForInProcessTurn(lockPath: string, deadline: number): Promise<() => void> {
	const previous = inProcessHolders.get(lockPath) ?? Promise.resolve();
	let leave: () => void = () => undefined;
	const left = new Promise<void>((resolve) => {
		leave = resolve;
	});
	const tail = previous.then(() => left);
	inProcessHolders.set(lockPath, tail);
	void tail.then(() => {
		if (inProcessHolders.get(lockPath) === tail) inProcessHolders.delete(lockPath);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
	});
	const turn = await Promise.race([previous.then(() => true as const), expired]);
	clearTimeout(timer);
	if (turn) return leave;
	// Given up: the callers behind this one wait only for the ones ahead of it.
	leave();
	throw new LockWaitTimeoutError(lockPath);
}

export async function acquireOwnershipSafeLock(
	lockPath: string,
	options: OwnershipSafeLockOptions = {},
): Promise<() => Promise<void>> {
	const retries = options.retries ?? DEFAULT_RETRIES;
	// One cumulative deadline caps the total wait (proper-lockfile's profile
	// waited ~10s), the in-process wait included; each SQLite busy wait stays SHORT
	// because it blocks the event loop synchronously - a long busy_timeout would
	// stop a same-process holder from ever finishing its critical section - and the
	// async sleep between attempts yields without adding to the budget (the deadline
	// is the only limit).
	const deadline = Date.now() + retries.retries * retries.maxTimeout;
	// A legacy directory is refused at once, not after the wait for an in-process holder.
	await rejectLegacyDirectory(lockPath);
	const leave = options.validateFile === undefined ? () => undefined : await waitForInProcessTurn(lockPath, deadline);
	try {
		const release = await attemptUntil(lockPath, options.validateFile, retries, deadline);
		return async () => {
			try {
				await release();
			} finally {
				leave();
			}
		};
	} catch (error: unknown) {
		leave();
		throw error;
	}
}

async function attemptUntil(
	lockPath: string,
	validateFile: (() => Promise<FileIdentity>) | undefined,
	retries: NonNullable<OwnershipSafeLockOptions["retries"]>,
	deadline: number,
): Promise<() => Promise<void>> {
	while (true) {
		await rejectLegacyDirectory(lockPath);
		const busyMs = Math.max(1, Math.min(retries.maxTimeout, deadline - Date.now()));
		let database: LockDatabase | undefined;
		try {
			database = await openLockDatabase(lockPath, validateFile);
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

/**
 * Contention, classified by code only, never by message (a message may name a path that says "busy" or "locked"): the
 * SQLite primary result SQLITE_BUSY (5) or SQLITE_LOCKED (6), from node:sqlite's `errcode` or bun:sqlite's
 * `SQLITE_BUSY*`/`SQLITE_LOCKED*` code, and this module's own busy refusals.
 */
export function isBusy(error: unknown): boolean {
	if (error instanceof LockFileBusyError || error instanceof LockWaitTimeoutError) return true;
	if (typeof error !== "object" || error === null) return false;
	const errcode = Reflect.get(error, "errcode");
	if (typeof errcode === "number") return (errcode & 0xff) === 5 || (errcode & 0xff) === 6;
	const code = Reflect.get(error, "code");
	return typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code);
}
