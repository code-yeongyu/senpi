import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";

/** A log sink that failed waits this long before it tries the file again, so it recovers instead of staying off. */
export const LOG_SINK_RETRY_MS = 5_000;

const ROTATION_LOCK_STALE_MS = 10_000;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function exceedsCap(filePath: string, incomingBytes: number, maxBytes: number): boolean {
	try {
		return statSync(filePath).size + incomingBytes > maxBytes;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

interface LockOwner {
	pid: number;
	nonce: string;
}

function parseLockOwner(content: string): LockOwner | undefined {
	const match = /^(\d+):(\S+)$/.exec(content.trim());
	if (match === null) return undefined;
	return { pid: Number(match[1]), nonce: match[2] };
}

/** Reads the `<pid>:<nonce>` owner recorded in a lock file, or undefined when it is missing or unreadable. */
function readLockOwner(lockPath: string): LockOwner | undefined {
	try {
		return parseLockOwner(readFileSync(lockPath, "utf8"));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return false;
		if (errorCode(error) === "EPERM") return true;
		throw error;
	}
}

function clearStaleLock(lockPath: string): void {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(lockPath).mtimeMs;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	if (Date.now() - mtimeMs <= ROTATION_LOCK_STALE_MS) return;
	const owner = readLockOwner(lockPath);
	if (owner !== undefined) {
		// A stale lock whose owner is still running belongs to a paused holder, not a crashed one
		// (senpi#2981): never clear it, or two writers could take the lock and rotate together
		// while the holder is still working.
		if (isProcessAlive(owner.pid)) return;
		// Re-read before removing, so a fresh lock taken since the first read is never removed.
		const current = readLockOwner(lockPath);
		if (current === undefined || current.pid !== owner.pid || current.nonce !== owner.nonce) return;
	}
	// An ownerless lock (written by an older release, or one whose owner write never landed) falls
	// back to the previous staleness-only removal.
	try {
		rmSync(lockPath, { force: true });
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

/**
 * Rotates `filePath` to `filePath.1` once appending `incomingBytes` would pass `maxBytes`. Several processes append
 * to one log (engine host, CLI, desktop host), so the rotation runs under an exclusive lock file and re-checks the
 * size while holding it: the process that loses the race keeps appending instead of failing, and never moves the
 * fresh file over the generation another process just rotated (senpi#2976). A held lock skips rotation for this
 * line; a lock left by a crashed process is cleared once it is stale. The lock records its owner (`<pid>:<nonce>`)
 * so a stale lock is only cleared once its owner is gone, and cleanup only removes the lock this process took
 * (senpi#2981).
 */
export function rotateLogIfNeeded(filePath: string, incomingBytes: number, maxBytes: number): void {
	if (!exceedsCap(filePath, incomingBytes, maxBytes)) return;
	const lockPath = `${filePath}.rotate-lock`;
	const nonce = randomUUID();
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		clearStaleLock(lockPath);
		return;
	}
	try {
		// Record who holds the lock; a write failure here leaves the lock anonymous, which
		// clearStaleLock still treats as stale-removable, as before.
		try {
			writeSync(lock, `${process.pid}:${nonce}`);
		} catch {
			// ignore: the lock file itself is what serializes rotation
		}
		if (!exceedsCap(filePath, incomingBytes, maxBytes)) return;
		try {
			renameSync(filePath, `${filePath}.1`);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw error;
		}
		chmodSync(`${filePath}.1`, 0o600);
	} finally {
		closeSync(lock);
		// Remove only our own lock: another process may have taken a fresh lock if ours was cleared
		// while we held it, and removing that one would let two rotations run together.
		if (readLockOwner(lockPath)?.nonce === nonce) rmSync(lockPath, { force: true });
	}
}
