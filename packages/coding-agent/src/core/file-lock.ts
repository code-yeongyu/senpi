/**
 * The entry point for async proper-lockfile locks (test/proper-lockfile-reference-guard.test.ts
 * rejects any other proper-lockfile reference under packages/<name>/src except listed lockSync users
 * and listed vendored self-contained files, whose every lock call passes its own onCompromised).
 *
 * proper-lockfile 4.1.2 refreshes a held lock from a timer: it `stat`s the lock directory, then
 * `utimes` it. Only the `utimes` callback checks `lock.released`. An unlock that lands while the
 * `stat` is in flight therefore gets a late ENOENT for its own, already-removed lock directory,
 * and the dependency reports that as a compromise. The default `onCompromised` throws from a
 * timer callback, which is an uncaught exception that kills the process.
 *
 * `lockWithLossHandling` always passes an `onCompromised` that never throws:
 * - after `release()` it is a no-op (the release race above; nothing is wrong);
 * - while the lock is held it marks the lock lost, logs one structured entry, and calls `onLost`.
 *   A holder that lost a live lock must stop: a long-lived owner passes an `onLost` that stops it,
 *   and every write under the lock calls `assertHeld()` right before its write or rename, so it
 *   fails with a typed `FileLockLostError` instead of overwriting the new owner's state.
 */
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { appendDebugLogEntry } from "./hidden-stdout-log.ts";

export type FileLockOptions = Omit<lockfile.LockOptions, "onCompromised"> & {
	/** Called once, while the lock is still held, when the lock is reported compromised. Must not throw. */
	onLost?: (error: Error) => void;
};

export interface HeldFileLock {
	/** Releases the lock. A lost lock is already gone, so releasing it is a no-op. */
	release(): Promise<void>;
	/** True once the lock was reported compromised while held. */
	lost(): boolean;
	/** Throws FileLockLostError when the lock was lost; call right before the commit step. */
	assertHeld(): void;
}

export class FileLockLostError extends Error {
	readonly code = "ELOCKLOST";
	readonly path: string;

	constructor(path: string, cause: Error) {
		super(
			`File lock on ${basename(path)} was lost before the write committed: the lock was removed or reclaimed by another process. The write was skipped.`,
			{ cause },
		);
		this.name = "FileLockLostError";
		this.path = path;
	}
}

/** Logs never carry absolute paths: a lock is named by its basename plus a short hash of its full path. */
function lockLogFields(path: string): { lock: string; lockId: string } {
	return { lock: basename(path), lockId: createHash("sha256").update(path).digest("hex").slice(0, 12) };
}

function logLockEvent(header: string, fields: Record<string, unknown>): void {
	try {
		appendDebugLogEntry(header, JSON.stringify(fields));
	} catch {
		// The debug log is best effort; this runs on a heartbeat timer, so nothing here may throw.
	}
}

type LockFs = typeof nodeFs;

/**
 * The lock library removes a lock directory by path, on release and on a stale takeover alike, and never checks that
 * the directory is still the one this holder created (senpi#6428). A holder that lost its lock without learning it (its
 * refresh stalled past the stale bound and another caller took the lock over) would delete the NEW holder's lock, so a
 * third caller could take it while the second is still writing. Each holder therefore writes a random owner token to
 * `<lock dir>.owner` right after acquiring, and its removal of the lock directory goes ahead only while that token is
 * still its own; otherwise it removes nothing and reports the lock as lost. The token lives BESIDE the directory so the
 * library's stale takeover (and plain lockSync users) can still remove an empty directory. Before the lock is held (the
 * library's own takeover of another holder's dead lock) the directory is removed as before, after its stale token. The
 * exit-time removal (rmdirSync) is checked the same way. What remains is the few microseconds between reading the
 * token and removing the directory, against up to one refresh interval before.
 */
function ownerCheckedFs(
	base: LockFs,
	ownToken: () => string | undefined,
	onForeign: (lockDir: string) => void,
): LockFs {
	// The token file is ours, so a caller-supplied fs that lacks a method falls back to node:fs for it.
	const tokenFs = {
		readFile: base.readFile ?? nodeFs.readFile,
		unlink: base.unlink ?? nodeFs.unlink,
		readFileSync: base.readFileSync ?? nodeFs.readFileSync,
		unlinkSync: base.unlinkSync ?? nodeFs.unlinkSync,
	};
	// Before this holder owns the lock (the library's takeover of a stale lock, or its cleanup of a failed acquire),
	// removal stays plain, but the previous holder's token goes first: a stale holder that releases while this
	// takeover is still between mkdir and the new token must find no token, not its own.
	const verdict = (
		token: string,
		current: string | undefined,
		readError: NodeJS.ErrnoException | null,
	): "own" | "foreign" =>
		readError?.code === "ENOENT" || (readError === null && current !== token) ? "foreign" : "own";
	const rmdir = (lockDir: string, callback: (error: NodeJS.ErrnoException | null) => void): void => {
		const token = ownToken();
		if (token === undefined) {
			tokenFs.unlink(`${lockDir}.owner`, () => base.rmdir(lockDir, callback));
			return;
		}
		tokenFs.readFile(`${lockDir}.owner`, "utf8", (readError, current) => {
			// Only a missing token or someone else's means the lock changed hands; any other read error keeps the
			// pre-fix behavior (remove the directory) instead of leaving a dead lock behind for retries:0 callers.
			if (verdict(token, current, readError) === "foreign") {
				onForeign(lockDir);
				callback(null);
				return;
			}
			tokenFs.unlink(`${lockDir}.owner`, () => base.rmdir(lockDir, callback));
		});
	};
	// The library also removes every lock it believes it holds when the process exits, synchronously.
	const rmdirSync = (lockDir: string): void => {
		const token = ownToken();
		if (token !== undefined) {
			let current: string | undefined;
			let readError: NodeJS.ErrnoException | null = null;
			try {
				current = tokenFs.readFileSync(`${lockDir}.owner`, "utf8");
			} catch (error) {
				readError = error as NodeJS.ErrnoException;
			}
			if (verdict(token, current, readError) === "foreign") {
				onForeign(lockDir);
				return;
			}
		}
		try {
			tokenFs.unlinkSync(`${lockDir}.owner`);
		} catch {
			// No token file: nothing to remove beside the directory.
		}
		base.rmdirSync(lockDir);
	};
	// A plain object, never a prototype write: under Bun the node:fs module namespace is frozen, and an object built on
	// it with Object.create cannot take an own rmdir (TypeError, readonly property). A spread would drop inherited methods.
	// Every method the caller's fs offers, own or inherited (for...in), copied onto a fresh object.
	const copy: Record<string, unknown> = {};
	for (const key in base) copy[key] = (base as unknown as Record<string, unknown>)[key];
	return Object.assign(copy, { rmdir, rmdirSync }) as unknown as LockFs;
}

export async function lockWithLossHandling(path: string, options: FileLockOptions = {}): Promise<HeldFileLock> {
	const { onLost, ...lockOptions } = options;
	let released = false;
	let lostError: Error | undefined;
	let ownerToken: string | undefined;
	// The library's own default is graceful-fs (its retry-on-EMFILE wrapper). Passing an fs replaces that default, so
	// the lock calls (mkdir, stat, utimes, rmdir: one each per acquire, refresh or release) now use node:fs directly.
	const baseFs = (lockOptions as { fs?: LockFs }).fs ?? nodeFs;
	const releaseLock = await lockfile.lock(path, {
		...lockOptions,
		fs: ownerCheckedFs(
			baseFs,
			() => ownerToken,
			(lockDir) => {
				// Found at release: the holder learns it lost the lock, and the new holder's lock stays.
				if (lostError !== undefined) return;
				lostError = Object.assign(new Error("file lock was taken over by another holder before release"), {
					code: "ECOMPROMISED",
				});
				logLockEvent("file lock found taken over at release", {
					event: "file_lock_lost_at_release",
					...lockLogFields(lockDir),
				});
			},
		),
		onCompromised: (error: Error) => {
			if (released || lostError !== undefined) return;
			lostError = error;
			const fields = lockLogFields(lockOptions.lockfilePath ?? `${path}.lock`);
			logLockEvent("file lock lost while held", {
				event: "file_lock_lost",
				...fields,
				code: (error as NodeJS.ErrnoException).code,
			});
			try {
				onLost?.(error);
			} catch (callbackError) {
				logLockEvent("file lock onLost callback threw", {
					event: "file_lock_on_lost_threw",
					...fields,
					name: callbackError instanceof Error ? callbackError.name : typeof callbackError,
					code: (callbackError as NodeJS.ErrnoException | undefined)?.code,
				});
			}
		},
	});
	try {
		// The same directory the library locked: an explicit lockfilePath as given, else <file>.lock where the file is
		// canonicalised exactly as the library decides (its default is realpath: true, overridden by any explicit value).
		// Async: this runs on the session path, whose synchronous fs calls are frozen (no-sync-in-session-path).
		const canonical = { realpath: true, ...lockOptions }.realpath;
		const lockDir =
			lockOptions.lockfilePath ?? `${canonical ? await nodeFs.promises.realpath(path) : resolve(path)}.lock`;
		const token = randomBytes(16).toString("hex");
		await nodeFs.promises.writeFile(`${lockDir}.owner`, token, { mode: 0o600 });
		ownerToken = token;
	} catch {
		// No token: release falls back to the library's plain removal, never worse than before.
	}
	return {
		release: async () => {
			if (released) return;
			released = true;
			if (lostError !== undefined) return;
			await releaseLock();
		},
		lost: () => lostError !== undefined,
		assertHeld: () => {
			if (lostError !== undefined) throw new FileLockLostError(path, lostError);
		},
	};
}
