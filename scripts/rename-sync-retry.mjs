#!/usr/bin/env node
// Bounded renameSync retry for Windows sharing violations (EPERM/EBUSY/ENOTEMPTY).
// Clock and rename are injectable so tests never wait on wall time.

import { renameSync as fsRenameSync } from "node:fs";

const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 250;

export { TRANSIENT_CODES };

export class RenameSyncRetryError extends Error {
	/**
	 * @param {string} oldPath
	 * @param {string} newPath
	 * @param {number} deadlineMs
	 * @param {unknown} cause
	 */
	constructor(oldPath, newPath, deadlineMs, cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`rename '${oldPath}' -> '${newPath}' failed after ${deadlineMs}ms: ${detail}`, { cause });
		this.name = "RenameSyncRetryError";
		if (cause && typeof cause === "object" && "code" in cause) {
			this.code = /** @type {{ code: unknown }} */ (cause).code;
		}
	}
}

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function errorCode(error) {
	if (error && typeof error === "object" && "code" in error) {
		const code = /** @type {{ code: unknown }} */ (error).code;
		return code == null ? undefined : String(code);
	}
	return undefined;
}

/**
 * @param {number} ms
 */
function sleepSync(ms) {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @typedef {{
 *   renameSync?: (oldPath: string, newPath: string) => void;
 *   now?: () => number;
 *   sleep?: (ms: number) => void;
 *   deadlineMs?: number;
 *   backoffMs?: number;
 * }} RenameSyncRetryOptions
 */

/**
 * Rename `oldPath` to `newPath`, retrying only transient Windows sharing codes
 * until `deadlineMs`. Non-transient errors throw immediately. Deadline expiry
 * throws RenameSyncRetryError with the last error as `cause`.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @param {RenameSyncRetryOptions} [options]
 */
export function renameSyncRetry(oldPath, newPath, options = {}) {
	const rename = options.renameSync ?? fsRenameSync;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? sleepSync;
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
	const start = now();
	for (let attempt = 0; ; attempt++) {
		try {
			rename(oldPath, newPath);
			return;
		} catch (error) {
			const code = errorCode(error);
			if (!code || !TRANSIENT_CODES.has(code)) throw error;
			const remaining = deadlineMs - (now() - start);
			if (remaining <= 0) {
				throw new RenameSyncRetryError(oldPath, newPath, deadlineMs, error);
			}
			sleep(Math.min(backoffMs * 2 ** Math.min(attempt, 6), MAX_BACKOFF_MS, remaining));
		}
	}
}
