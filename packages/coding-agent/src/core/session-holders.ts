import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import { errorCode } from "./extensions/builtin/terminal/lease-file.ts";
import { ownProcessStartedAtMs, processBootAtMs } from "./extensions/builtin/terminal/process-identity.ts";
import {
	SessionHeldError,
	type SessionHolder,
	type SessionHolderEndpoint,
	SessionMovedError,
	SessionMovingError,
} from "./session-hold-errors.ts";
import { type HolderGeneration, liveHolders, type SessionHolderProbes } from "./session-holder-records.ts";
import { activeMover, underMoveLock } from "./session-move-lock.ts";
import { encodedSessionId } from "./session-sidecar-store.ts";
import { carryStartClaim, dropStartClaim, startClaimant, takeStartClaim } from "./session-start-claim.ts";
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
const DEFAULT_MOVE_LOCK_WAIT_MS = 5_000;

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

// `release()` is synchronous (it also runs at exit), so the holder side keeps a synchronous removal.
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
	const mover = await activeMover(dir);
	if (mover !== undefined) {
		release();
		throw new SessionMovingError(sessionFile, mover.pid);
	}
	if (options.expectExisting && !existsSync(resolveMovedPath(sessionFile))) {
		release();
		throw new SessionMovedError(sessionFile);
	}
	// The record now stands for this process, so the start claim taken at admission has done its part (senpi#5988). A
	// claim another start broke (it expired) let that start in: re-check now that this record is visible to it.
	if ((await dropStartClaim(sessionId)) === "lost") {
		const others = (await liveSessionHolders(sessionFile, sessionId)).filter(({ pid }) => pid !== process.pid);
		if (others.length > 0) {
			release();
			throw new SessionHeldError(sessionFile, others);
		}
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
	const dir = holdersDir(sessionFile, sessionId);
	let holders: SessionHolder[];
	try {
		holders = await liveHolders(dir, probes, () => advanceSessionFence(sessionFile));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		holders = [];
	}
	// A start that claimed the session is a holder before its record exists (senpi#5988).
	const claimant = await startClaimant(dir, probes);
	return claimant === undefined || holders.some(({ pid }) => pid === claimant.pid) ? holders : [...holders, claimant];
}

/**
 * Claims the start of `sessionFile` for this process (senpi#5988): true when it now holds the claim, false when another
 * live process does. The claim counts as a holder until this process's hold on the session publishes its record.
 */
export async function claimSessionStart(sessionFile: string, sessionId: string): Promise<boolean> {
	return takeStartClaim(holdersDir(sessionFile, sessionId), sessionId, await identityRecord(process.cwd()));
}

/**
 * Runs `move` holding the session's move lock, after proving no live process holds the session.
 * Waits up to `waitMs` for a concurrent move to finish, then fails with `SessionMovingError`.
 */
export async function withSessionMoveLock<T>(
	sessionFile: string,
	sessionId: string,
	move: () => T | Promise<T>,
	options: {
		readonly waitMs?: number;
		/** Where the move puts the session file; a start claim this process holds moves there with it. */
		readonly destination?: string;
	} = {},
): Promise<T> {
	const dir = holdersDir(sessionFile, sessionId);
	const identity = await identityRecord();
	const waitMs = options.waitMs ?? DEFAULT_MOVE_LOCK_WAIT_MS;
	if (options.destination === undefined) return underMoveLock(sessionFile, dir, identity, move, waitMs);
	// A start that admitted the session and now moves it (a rebind) holds its start claim at the destination before the
	// file arrives there, so a start on the new path finds it (senpi#5988).
	const destination = options.destination;
	const carried = await carryStartClaim(
		sessionId,
		holdersDir(destination, sessionId),
		await identityRecord(process.cwd()),
	);
	if (carried === false) throw new SessionHeldError(destination, await liveSessionHolders(destination, sessionId));
	try {
		const moved = await underMoveLock(sessionFile, dir, identity, move, waitMs);
		await carried?.commit();
		return moved;
	} catch (error) {
		await carried?.abort();
		throw error;
	}
}
