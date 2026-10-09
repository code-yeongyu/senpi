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
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import {
	breakStaleLock,
	errorCode,
	type LockProbes,
	publishExclusive,
	readLeaseText,
	reclaimLockState,
	unlinkIfPresent,
} from "./extensions/builtin/terminal/lease-file.ts";
import { ownProcessStartedAtMs, processBootAtMs } from "./extensions/builtin/terminal/process-identity.ts";
import { SessionHeldError, type SessionHolder, SessionMovedError, SessionMovingError } from "./session-hold-errors.ts";
import { encodedSessionId } from "./session-sidecar-store.ts";

export { SessionHeldError, type SessionHolder, SessionMovedError, SessionMovingError };

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
const HOLDER_RECORD = /^\d+\.json$/;
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

function identityRecord(cwd?: string): string {
	return JSON.stringify({
		pid: process.pid,
		bootAtMs: processBootAtMs(),
		processStartedAtMs: ownProcessStartedAtMs(),
		...(cwd === undefined ? {} : { cwd }),
	});
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

function parseCwd(raw: string): string | undefined {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("cwd" in parsed)) return undefined;
	return typeof parsed.cwd === "string" ? parsed.cwd : undefined;
}

/**
 * Publishes this process as a holder of `sessionFile` until `release()`. Throws `SessionMovingError`
 * while another process is moving the session, and `SessionMovedError` when a session that was read
 * from disk (`expectExisting`) is gone, so nothing is ever appended to a path the session left.
 */
export function holdSessionFile(
	sessionFile: string,
	sessionId: string,
	options: { readonly cwd?: string; readonly expectExisting: boolean },
): SessionHold {
	const dir = holdersDir(sessionFile, sessionId);
	const record = join(dir, `${process.pid}.json`);
	const shared = holderRecordRefCounts.get(record) ?? 0;
	if (shared === 0) {
		publishHolderRecord(dir, record, identityRecord(options.cwd));
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

// A finishing move removes the emptied directory, so a writer racing it recreates the directory once.
function publishHolderRecord(dir: string, record: string, content: string): void {
	for (let attempt = 0; ; attempt += 1) {
		mkdirSync(dir, { recursive: true });
		const temp = `${record}.${randomUUID().slice(0, 8)}.tmp`;
		try {
			writeFileSync(temp, content);
			renameSync(temp, record);
			return;
		} catch (error) {
			if (errorCode(error) !== "ENOENT" || attempt > 0) throw error;
		}
	}
}

async function liveHolders(dir: string, probes: LockProbes = {}): Promise<SessionHolder[]> {
	const holders: SessionHolder[] = [];
	for (const name of await readdir(dir)) {
		if (!HOLDER_RECORD.test(name)) continue;
		const path = join(dir, name);
		const state = await reclaimLockState(path, probes);
		if (state.state === "stale") await breakStaleLock(path, state.raw);
		if (state.state !== "held" || state.holder === undefined) continue;
		const raw = await readLeaseText(path);
		holders.push({ pid: state.holder.pid, cwd: raw === undefined ? undefined : parseCwd(raw) });
	}
	return holders;
}

/**
 * Live processes that have `sessionFile` open right now (stale records of dead or reused pids are
 * reclaimed on the way). A caller about to start another writer uses it to wait instead of racing one.
 */
export async function liveSessionHolders(
	sessionFile: string,
	sessionId: string,
	probes: LockProbes = {},
): Promise<SessionHolder[]> {
	try {
		return await liveHolders(holdersDir(sessionFile, sessionId), probes);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
}

async function takeMoveLock(sessionFile: string, lock: string, waitMs: number): Promise<string> {
	const mine = identityRecord();
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			await publishExclusive(lock, mine);
			return mine;
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT") {
				mkdirSync(dirname(lock), { recursive: true });
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
