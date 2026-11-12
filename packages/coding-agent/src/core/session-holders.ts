import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import {
	breakStaleLock,
	errorCode,
	publishExclusive,
	readLeaseText,
	reclaimLockState,
	unlinkIfPresent,
} from "./extensions/builtin/terminal/lease-file.ts";
import { ownProcessStartedAtMs, processBootAtMs } from "./extensions/builtin/terminal/process-identity.ts";
import {
	SessionHeldError,
	type SessionHolder,
	type SessionHolderEndpoint,
	SessionMovedError,
	SessionMovingError,
} from "./session-hold-errors.ts";
import { type HolderGeneration, liveHolders, type SessionHolderProbes } from "./session-holder-records.ts";
import { encodedSessionId } from "./session-sidecar-store.ts";
import { advanceSessionFence } from "./session-write-fence.ts";

export {
	type HolderGeneration,
	SessionHeldError,
	type SessionHolder,
	type SessionHolderProbes,
	SessionMovedError,
	SessionMovingError,
};

/**
 * Cross-process ownership of a session file. Every process that has a session open publishes a holder
 * record `<sessionDir>/session-holders/<id>/<pid>.json` carrying its process identity; moving the session
 * takes `move.lock` in the same directory. The records reuse the terminal lease format, so a crashed
 * holder or a reused pid is recognised as stale instead of pinning the session forever.
 *
 * Ordering makes the pair race-free: an opener publishes its record and then looks for a move lock; a
 * mover takes the lock and then looks for records. Whichever runs second sees the other.
 */

const HOLDERS_DIR = "session-holders";
const MOVE_LOCK = "move.lock";
// A move rewrites one file and a few sidecars; a lock older than this belongs to a mover that died.
const MOVE_LOCK_STALE_MS = 30_000;
const DEFAULT_MOVE_LOCK_WAIT_MS = 5_000;
const MOVE_LOCK_RETRY_MS = 100;

export interface SessionHold {
	release(): void;
}

// A claim on an old spelling of a session file the desktop moved is a claim on the moved file (senpi#2898).
function holdersDir(sessionFile: string, sessionId: string): string {
	return join(dirname(resolveMovedPath(sessionFile)), HOLDERS_DIR, encodedSessionId(sessionId));
}

/** What a holder publishes for a session it has open: its identity and, for an RPC host, that host's endpoint. */
export interface HolderRecord extends Partial<SessionHolderEndpoint> {
	readonly pid: number;
	readonly bootAtMs: number;
	readonly processStartedAtMs: number;
	readonly cwd?: string;
}

async function identityRecord(cwd?: string, endpoint?: SessionHolderEndpoint): Promise<string> {
	const record: HolderRecord = {
		pid: process.pid,
		bootAtMs: await processBootAtMs(),
		processStartedAtMs: ownProcessStartedAtMs(),
		...(cwd === undefined ? {} : { cwd }),
		...endpoint,
	};
	return JSON.stringify(record);
}

function unlinkIfPresentSync(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function removeDirIfEmpty(dir: string): void {
	try {
		rmdirSync(dir);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	}
}

const holderRecordRefCounts = new Map<string, number>();
let exitCleanupInstalled = false;

function installExitCleanup(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", () => {
		for (const record of holderRecordRefCounts.keys()) unlinkIfPresentSync(record);
	});
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function activeMover(lock: string): { readonly pid: number | undefined } | undefined {
	let raw: string;
	let ageMs: number;
	try {
		raw = readFileSync(lock, "utf8");
		ageMs = Date.now() - statSync(lock).mtimeMs;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	if (ageMs > MOVE_LOCK_STALE_MS) return undefined;
	const pid = parsePid(raw);
	if (pid === undefined) return { pid };
	return pid === process.pid || pidAlive(pid) ? { pid } : undefined;
}

function parsePid(raw: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return undefined;
		return typeof parsed.pid === "number" ? parsed.pid : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/**
 * Publishes this process as a holder of `sessionFile` until `release()`. Throws `SessionMovingError`
 * while another process is moving the session, and `SessionMovedError` when a session that was read
 * from disk (`expectExisting`) is gone, so nothing is ever appended to a path the session left.
 */
export async function holdSessionFile(
	sessionFile: string,
	sessionId: string,
	options: {
		readonly cwd?: string;
		readonly expectExisting: boolean;
		readonly holderEndpoint?: SessionHolderEndpoint;
	},
): Promise<SessionHold> {
	// Resolved before the reference count is read, so nothing yields between that check and the record it guards.
	const identity = await identityRecord(options.cwd, options.holderEndpoint);
	const dir = holdersDir(sessionFile, sessionId);
	const record = join(dir, `${process.pid}.json`);
	const shared = holderRecordRefCounts.get(record) ?? 0;
	if (shared === 0) {
		publishHolderRecord(dir, record, identity);
		installExitCleanup();
	}
	holderRecordRefCounts.set(record, shared + 1);
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		const left = (holderRecordRefCounts.get(record) ?? 1) - 1;
		if (left > 0) {
			holderRecordRefCounts.set(record, left);
			return;
		}
		holderRecordRefCounts.delete(record);
		unlinkIfPresentSync(record);
		removeDirIfEmpty(dir);
	};
	const mover = activeMover(join(dir, MOVE_LOCK));
	if (mover !== undefined) {
		release();
		throw new SessionMovingError(sessionFile, mover.pid);
	}
	if (options.expectExisting && !existsSync(resolveMovedPath(sessionFile))) {
		release();
		throw new SessionMovedError(sessionFile);
	}
	return { release };
}

// A finishing move removes the emptied directory, so a writer racing it recreates the directory once. The mkdir is
// inside the retry too: a recursive mkdir that finds the directory just created stats it, and fails with ENOENT when
// that removal lands in between (senpi#5618).
function publishHolderRecord(dir: string, record: string, content: string): void {
	for (let attempt = 0; ; attempt += 1) {
		const temp = `${record}.${randomUUID().slice(0, 8)}.tmp`;
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(temp, content);
			renameSync(temp, record);
			return;
		} catch (error) {
			if (errorCode(error) !== "ENOENT" || attempt > 0) throw error;
		}
	}
}

/**
 * Live processes that have `sessionFile` open right now (stale records of dead or reused pids are
 * reclaimed on the way). A caller about to start another writer uses it to wait instead of racing one.
 */
export async function liveSessionHolders(
	sessionFile: string,
	sessionId: string,
	probes: SessionHolderProbes = {},
): Promise<SessionHolder[]> {
	try {
		return await liveHolders(holdersDir(sessionFile, sessionId), probes, () => advanceSessionFence(sessionFile));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
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

async function takeMoveLock(sessionFile: string, lock: string, waitMs: number): Promise<string> {
	const mine = await identityRecord();
	const deadline = Date.now() + waitMs;
	let lockDirVanished = false;
	while (true) {
		try {
			await publishExclusive(lock, mine);
			return mine;
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
 * Runs `move` holding the session's move lock, after proving no live process holds the session.
 * Waits up to `waitMs` for a concurrent move to finish, then fails with `SessionMovingError`.
 */
export async function withSessionMoveLock<T>(
	sessionFile: string,
	sessionId: string,
	move: () => T | Promise<T>,
	options: { readonly waitMs?: number } = {},
): Promise<T> {
	const dir = holdersDir(sessionFile, sessionId);
	const lock = join(dir, MOVE_LOCK);
	const mine = await takeMoveLock(sessionFile, lock, options.waitMs ?? DEFAULT_MOVE_LOCK_WAIT_MS);
	try {
		const holders = await liveHolders(dir);
		if (holders.length > 0) throw new SessionHeldError(sessionFile, holders);
		return await move();
	} finally {
		if ((await readLeaseText(lock)) === mine) await unlinkIfPresent(lock);
		removeDirIfEmpty(dir);
	}
}
