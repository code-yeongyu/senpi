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
import { createHash } from "node:crypto";
import { basename } from "node:path";
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

export async function lockWithLossHandling(path: string, options: FileLockOptions = {}): Promise<HeldFileLock> {
	const { onLost, ...lockOptions } = options;
	let released = false;
	let lostError: Error | undefined;
	const releaseLock = await lockfile.lock(path, {
		...lockOptions,
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
