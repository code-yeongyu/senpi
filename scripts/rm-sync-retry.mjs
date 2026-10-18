#!/usr/bin/env node
// Bounded recursive rmSync retry for Windows sharing violations (EBUSY/EPERM/ENOTEMPTY): a process
// that just exited can hold a file in the directory for a moment. Unlike rename-sync-retry.mjs, a
// directory still held at the deadline is reported, not thrown: callers use this for teardown,
// where a leftover temp directory must not decide a test result (senpi#2657).
// Clock and rm are injectable so tests never wait on wall time.

import { rmSync as fsRmSync } from "node:fs";

const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 250;

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
 *   rmSync?: (path: string) => void;
 *   now?: () => number;
 *   sleep?: (ms: number) => void;
 *   deadlineMs?: number;
 *   backoffMs?: number;
 * }} RmSyncRetryOptions
 */

/**
 * Remove `path` recursively, retrying only transient Windows sharing codes until `deadlineMs`.
 * Returns `{ removed: true }`, or `{ removed: false, error }` when the path is still held at the
 * deadline. Any other error throws immediately.
 *
 * @param {string} path
 * @param {RmSyncRetryOptions} [options]
 * @returns {{ removed: true } | { removed: false; error: unknown }}
 */
export function rmSyncRetry(path, options = {}) {
	const rm = options.rmSync ?? ((target) => fsRmSync(target, { recursive: true, force: true }));
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? sleepSync;
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
	const start = now();
	for (let attempt = 0; ; attempt++) {
		try {
			rm(path);
			return { removed: true };
		} catch (error) {
			const code = errorCode(error);
			if (!code || !TRANSIENT_CODES.has(code)) throw error;
			const remaining = deadlineMs - (now() - start);
			if (remaining <= 0) return { removed: false, error };
			sleep(Math.min(backoffMs * 2 ** Math.min(attempt, 6), MAX_BACKOFF_MS, remaining));
		}
	}
}
