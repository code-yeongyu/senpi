import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	breakStaleLock,
	errorCode,
	publishExclusive,
	readLeaseText,
	reclaimLockState,
	unlinkIfPresent,
} from "./extensions/builtin/terminal/lease-file.ts";
import { SessionHeldError, SessionMovingError } from "./session-hold-errors.ts";
import { liveHolders } from "./session-holder-records.ts";
import { removeEmptyDir, startClaimant } from "./session-start-claim.ts";

/**
 * The move lock of a session: `move.lock` in its holders directory, recording the mover's process identity. An opener
 * publishes its holder record and then looks for the lock; a mover takes the lock and then looks for records. The lock
 * is the mover's while the mover lives, however long the move runs (senpi#3979): it is stale only when its process is
 * gone or its pid now belongs to another process, judged by pid, boot and start instant as a holder record is.
 */

const MOVE_LOCK = "move.lock";
const MOVE_LOCK_RETRY_MS = 100;

/** The process moving the session whose holders live in `dir`, if a live one is; `pid` is unknown for a lock mid-write. */
export async function activeMover(dir: string): Promise<{ readonly pid: number | undefined } | undefined> {
	const state = await reclaimLockState(join(dir, MOVE_LOCK));
	return state.state === "held" ? { pid: state.holder?.pid } : undefined;
}

// A concurrent mover that finishes removes the emptied lock directory. A recursive mkdir that saw the directory
// exist and stats it after that removal fails with ENOENT (senpi#5618): the directory is merely gone again, so the
// publish fails once more and the next call here recreates it. Returns whether this mkdir hit that ENOENT. Only one
// in a row is tolerated: a second means the path can never be created (a dangling symlink), which fails fast. Who
// moves is still decided by the exclusive lock alone.
async function createLockDir(dir: string, tolerateEnoent: boolean): Promise<boolean> {
	try {
		await mkdir(dir, { recursive: true });
		return false;
	} catch (error) {
		if (!tolerateEnoent || errorCode(error) !== "ENOENT") throw error;
		return true;
	}
}

async function takeMoveLock(sessionFile: string, lock: string, identity: string, waitMs: number): Promise<void> {
	const deadline = Date.now() + waitMs;
	let lockDirVanished = false;
	while (true) {
		try {
			await publishExclusive(lock, identity);
			return;
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT") {
				lockDirVanished = await createLockDir(dirname(lock), !lockDirVanished);
				continue;
			}
			if (code !== "EEXIST") throw error;
		}
		const state = await reclaimLockState(lock);
		if (state.state === "stale") {
			await breakStaleLock(lock, state.raw);
			continue;
		}
		if (state.state === "free") continue;
		if (Date.now() >= deadline) throw new SessionMovingError(sessionFile, state.holder?.pid);
		await new Promise((resolve) => setTimeout(resolve, MOVE_LOCK_RETRY_MS));
	}
}

/**
 * Runs `move` holding the move lock of the session whose holders live in `dir`, after proving no live process holds
 * the session. Waits up to `waitMs` for a concurrent move to finish, then fails with `SessionMovingError`.
 */
export async function underMoveLock<T>(
	sessionFile: string,
	dir: string,
	identity: string,
	move: () => T | Promise<T>,
	waitMs: number,
): Promise<T> {
	const lock = join(dir, MOVE_LOCK);
	await takeMoveLock(sessionFile, lock, identity, waitMs);
	try {
		// Another process's start claim blocks a move; this process's own (a rebind right after admission) does not.
		const claimant = await startClaimant(dir);
		const holders = [
			...(await liveHolders(dir)),
			...(claimant === undefined || claimant.pid === process.pid ? [] : [claimant]),
		];
		if (holders.length > 0) throw new SessionHeldError(sessionFile, holders);
		return await move();
	} finally {
		if ((await readLeaseText(lock)) === identity) await unlinkIfPresent(lock);
		await removeEmptyDir(dir);
	}
}
