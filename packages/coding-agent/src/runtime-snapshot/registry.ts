import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { STAGING_PREFIX } from "./layout.ts";
import { RUNTIME_SNAPSHOT_MARKER } from "./marker.ts";

const LOCK_NAME = ".lock";
const CLAIMS_DIR = "claims";
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const BUILD_LOCK_PREFIX = ".build-";
const BUILD_WAIT_MS = 120_000;
const BUILD_RETRY_MS = 50;
/** A build lock whose holder never wrote its pid (it died right after creating it). */
const UNOWNED_BUILD_LOCK_MS = 30_000;
export const UNUSED_SNAPSHOT_GRACE_MS = 10 * 60_000;
const LEFTOVER_MS = 60 * 60_000;

function errorCode(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

function ageMs(path: string, now: number): number {
	try {
		return now - statSync(path).mtimeMs;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return Number.POSITIVE_INFINITY;
		throw error;
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `task` while holding the runtime root's lock; undefined when the lock stays busy.
 * The lock is a directory, so creating it is atomic on every platform and filesystem.
 */
export function withRuntimeLock<T>(root: string, task: () => T): T | undefined {
	mkdirSync(root, { recursive: true });
	const lock = join(root, LOCK_NAME);
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		if (ageMs(lock, Date.now()) > STALE_LOCK_MS) {
			rmSync(lock, { recursive: true, force: true });
		} else if (Date.now() > deadline) {
			return undefined;
		} else {
			sleepSync(LOCK_RETRY_MS);
		}
	}
	try {
		return task();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function buildLockHolder(lock: string): number | undefined {
	try {
		const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
		return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
		throw error;
	}
}

function isAbandonedBuildLock(lock: string, now: number, isAlive: (pid: number) => boolean): boolean {
	const holder = buildLockHolder(lock);
	return holder === undefined ? ageMs(lock, now) > UNOWNED_BUILD_LOCK_MS : !isAlive(holder);
}

/**
 * Runs `build` as the only builder of snapshot `id`; undefined when another live builder keeps it
 * past the wait. Building a snapshot copies thousands of files, so it runs under its own lock, not
 * the runtime root's, and never blocks launches of snapshots that already exist. A lock whose
 * holder died is taken over, and the dead builder's staging directories are removed first.
 */
export async function withBuildLock<T>(
	root: string,
	id: string,
	build: () => Promise<T>,
	isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<T | undefined> {
	mkdirSync(root, { recursive: true });
	const lock = join(root, `${BUILD_LOCK_PREFIX}${id}`);
	const deadline = Date.now() + BUILD_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, "pid"), String(process.pid));
			break;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		if (isAbandonedBuildLock(lock, Date.now(), isAlive)) {
			rmSync(lock, { recursive: true, force: true });
		} else if (Date.now() > deadline) {
			return undefined;
		} else {
			sleepSync(BUILD_RETRY_MS);
		}
	}
	try {
		for (const name of readdirSync(root)) {
			if (name.startsWith(`${STAGING_PREFIX}${id}-`)) rmSync(join(root, name), { recursive: true, force: true });
		}
		return await build();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: alive, owned by someone else. Anything but "no such process" keeps the snapshot.
		return errorCode(error) !== "ESRCH";
	}
}

export function claimRuntimeSnapshot(snapshotDir: string, pid: number): void {
	mkdirSync(join(snapshotDir, CLAIMS_DIR), { recursive: true });
	writeFileSync(join(snapshotDir, CLAIMS_DIR, String(pid)), "");
	const now = new Date();
	utimesSync(join(snapshotDir, RUNTIME_SNAPSHOT_MARKER), now, now);
}

function reapClaims(snapshotDir: string, isAlive: (pid: number) => boolean): number {
	let names: string[];
	try {
		names = readdirSync(join(snapshotDir, CLAIMS_DIR));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return 0;
		throw error;
	}
	let live = 0;
	for (const name of names) {
		const pid = Number(name);
		if (Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) {
			live += 1;
		} else {
			unlinkSync(join(snapshotDir, CLAIMS_DIR, name));
		}
	}
	return live;
}

/**
 * Removes snapshots no live process claims and nobody used within the grace period, plus
 * staging and trash leftovers of crashed launches. `keep` is the snapshot this launch runs.
 */
export function pruneRuntimeSnapshots(
	root: string,
	keep: string,
	now: number,
	isAlive: (pid: number) => boolean = isProcessAlive,
): void {
	reapClaims(join(root, keep), isAlive);
	for (const name of readdirSync(root)) {
		if (name === LOCK_NAME || name === keep) continue;
		const path = join(root, name);
		if (name.startsWith(".")) {
			if (ageMs(path, now) > LEFTOVER_MS) rmSync(path, { recursive: true, force: true });
			continue;
		}
		if (reapClaims(path, isAlive) > 0) continue;
		if (ageMs(join(path, RUNTIME_SNAPSHOT_MARKER), now) <= UNUSED_SNAPSHOT_GRACE_MS) continue;
		// Rename first: a half-deleted snapshot must never keep a name a launch could pick up.
		const trash = join(root, `.trash-${name}-${process.pid}`);
		renameSync(path, trash);
		rmSync(trash, { recursive: true, force: true });
	}
}
