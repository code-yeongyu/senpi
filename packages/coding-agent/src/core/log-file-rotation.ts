import { chmodSync, closeSync, openSync, renameSync, rmSync, statSync } from "node:fs";

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

function clearStaleLock(lockPath: string): void {
	try {
		if (Date.now() - statSync(lockPath).mtimeMs > ROTATION_LOCK_STALE_MS) rmSync(lockPath, { force: true });
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

/**
 * Rotates `filePath` to `filePath.1` once appending `incomingBytes` would pass `maxBytes`. Several processes append
 * to one log (engine host, CLI, desktop host), so the rotation runs under an exclusive lock file and re-checks the
 * size while holding it: the process that loses the race keeps appending instead of failing, and never moves the
 * fresh file over the generation another process just rotated (senpi#2976). A held lock skips rotation for this
 * line; a lock left by a crashed process is cleared once it is stale.
 */
export function rotateLogIfNeeded(filePath: string, incomingBytes: number, maxBytes: number): void {
	if (!exceedsCap(filePath, incomingBytes, maxBytes)) return;
	const lockPath = `${filePath}.rotate-lock`;
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		clearStaleLock(lockPath);
		return;
	}
	try {
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
		rmSync(lockPath, { force: true });
	}
}
