import { mkdir, rmdir, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	breakStaleLock,
	errorCode,
	type LockProbes,
	publishExclusive,
	readLeaseText,
	reclaimLockState,
	unlinkIfPresent,
} from "./extensions/builtin/terminal/lease-file.ts";
import type { SessionHolder } from "./session-hold-errors.ts";
import { parseCwd } from "./session-holder-records.ts";

/**
 * The start claim of a session (senpi#5988). Startup admission and the holder record a starting process publishes
 * are far apart: extensions and models load in between. A start therefore claims the session first, exclusively, in
 * `<holders dir>/start.claim`, and that claim counts as a holder until the process publishes its holder record or
 * ends. Of two simultaneous starts exactly one creates the file; the other finds a live holder, as a later start
 * finds the first one's record. The claim carries the same identity as a holder record, so once its process has ended
 * (cleanly, by a signal or a crash) or its pid belongs to another process, the claim is stale and the next reader breaks
 * it; no exit hook is needed, and none could do async work. It is published like the move lock (`link`, or an exclusive
 * create where a filesystem has no hard links), so it holds on win32 too.
 */

const START_CLAIM = "start.claim";
// A claim not refreshed this long belongs to a start that is stopped or whose event loop is blocked, and no longer keeps
// others out. A start whose loop runs keeps refreshing, so it stays the claimant however long it loads. Breaking an
// expired claim is safe: a claimant that finds its claim gone re-checks after publishing (`holdSessionFile`).
const START_CLAIM_STALE_MS = 5 * 60_000;
// A live claimant keeps its claim fresh while its start is still loading, so only a stopped process lets it expire.
const START_CLAIM_REFRESH_MS = 60_000;
// A claim whose pid is alive but whose start time cannot be read may belong to a process that reused the pid of an
// ended claimant. Its own claimant would have refreshed it; one not refreshed for three intervals has none (a margin
// of two missed refreshes for a claimant whose event loop stalls).
const UNPROVEN_CLAIM_STALE_MS = 3 * START_CLAIM_REFRESH_MS;

interface OwnClaim {
	readonly path: string;
	readonly raw: string;
	readonly refresh: ReturnType<typeof setInterval>;
}

// This process's claims by session id: the hold taken for the session drops its claim even after a rebind moved it.
const ownClaims = new Map<string, OwnClaim>();

/** Removes a holders directory once nothing is left in it; one another process just wrote to stays. */
export async function removeEmptyDir(dir: string): Promise<void> {
	try {
		await rmdir(dir);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	}
}

function release(claim: OwnClaim): Promise<void> {
	clearInterval(claim.refresh);
	return (async () => {
		if ((await readLeaseText(claim.path)) !== claim.raw) return;
		await unlinkIfPresent(claim.path);
		// The session's holders directory, then the shared `session-holders` beside the session file: a released claim
		// leaves nothing behind in a store another app owns (desktop#8097).
		await removeEmptyDir(dirname(claim.path));
		await removeEmptyDir(dirname(dirname(claim.path)));
	})();
}

/**
 * Drops this process's start claim on `sessionId`: after its holder record is published, or when the start does not
 * open the session. `lost` means the claim was this process's but another process broke it meanwhile.
 */
export async function dropStartClaim(sessionId: string): Promise<"none" | "dropped" | "lost"> {
	const claim = ownClaims.get(sessionId);
	if (claim === undefined) return "none";
	ownClaims.delete(sessionId);
	const lost = (await readLeaseText(claim.path)) !== claim.raw;
	await release(claim);
	return lost ? "lost" : "dropped";
}

type ClaimState =
	| { readonly state: "free" }
	| { readonly state: "stale"; readonly raw: string }
	| { readonly state: "held"; readonly raw: string; readonly pid: number | undefined; readonly unproven: boolean };

/** Who holds the claim at `path`: nobody, a process that no longer keeps others out (gone, or expired), or a live one. */
async function inspectClaim(path: string, probes: LockProbes): Promise<ClaimState> {
	const raw = await readLeaseText(path);
	if (raw === undefined) return { state: "free" };
	const lock = await reclaimLockState(path, probes);
	if (lock.state === "free") return { state: "free" };
	if (lock.state === "stale") return { state: "stale", raw: lock.raw };
	const claimedAt = await stat(path).then(
		(info) => info.mtimeMs,
		() => undefined,
	);
	const staleAfterMs = lock.unproven === true ? UNPROVEN_CLAIM_STALE_MS : START_CLAIM_STALE_MS;
	if (claimedAt !== undefined && Date.now() - claimedAt > staleAfterMs) return { state: "stale", raw };
	return { state: "held", raw, pid: lock.holder?.pid, unproven: lock.unproven === true };
}

// A finishing move removes the emptied directory (senpi#5618): the publish is retried, but a second ENOENT in a row
// means the directory cannot be created and fails fast. A broken stale claim frees the file for one more round; three
// breaks in a row mean other starts keep claiming and crashing, and the claim is left to the next one.
async function publishClaim(dir: string, path: string, identity: string): Promise<boolean> {
	let vanished = false;
	for (let breaks = 0; breaks < 3;) {
		try {
			await mkdir(dir, { recursive: true });
			await publishExclusive(path, identity);
			return true;
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT" && !vanished) {
				vanished = true;
				continue;
			}
			if (code !== "EEXIST") throw error;
		}
		vanished = false;
		const claim = await inspectClaim(path, {});
		if (claim.state === "held") return false;
		if (claim.state === "stale") {
			await breakStaleLock(path, claim.raw);
			breaks += 1;
		}
	}
	return false;
}

function adopt(sessionId: string, path: string, identity: string): void {
	const refresh = setInterval(() => void refreshClaim(path, identity), START_CLAIM_REFRESH_MS);
	refresh.unref();
	ownClaims.set(sessionId, { path, raw: identity, refresh });
}

/**
 * Claims the start of the session whose holder records live in `dir`. Returns false when a live process holds the
 * claim. A claim this process already holds is kept (a start admits a resumed file again before rebinding it).
 */
export async function takeStartClaim(dir: string, sessionId: string, identity: string): Promise<boolean> {
	const path = join(dir, START_CLAIM);
	const own = ownClaims.get(sessionId);
	if (own?.path === path && (await readLeaseText(path)) === own.raw) return true;
	if (own !== undefined) await dropStartClaim(sessionId);
	if (!(await publishClaim(dir, path, identity))) return false;
	adopt(sessionId, path, identity);
	return true;
}

/** A claim carried to a move's destination: `commit` drops the source's claim after the move, `abort` the destination's. */
export interface CarriedClaim {
	commit(): Promise<void>;
	abort(): Promise<void>;
}

/**
 * Carries this process's start claim on `sessionId` to the holders directory `dir` of a move's destination, before the
 * move, so a start on the destination finds it there (senpi#5988). `undefined` when this process holds no claim (nothing
 * to carry) or the destination is the same directory; false when another live start holds the destination.
 */
export async function carryStartClaim(
	sessionId: string,
	dir: string,
	identity: string,
): Promise<CarriedClaim | false | undefined> {
	const source = ownClaims.get(sessionId);
	const path = join(dir, START_CLAIM);
	if (source === undefined || source.path === path) return undefined;
	if (!(await publishClaim(dir, path, identity))) return false;
	adopt(sessionId, path, identity);
	return {
		commit: () => release(source),
		abort: async () => {
			const carried = ownClaims.get(sessionId);
			ownClaims.set(sessionId, source);
			if (carried !== undefined) await release(carried);
		},
	};
}

async function refreshClaim(path: string, raw: string): Promise<void> {
	try {
		if ((await readLeaseText(path)) !== raw) return;
		const now = new Date();
		await utimes(path, now, now);
	} catch {
		// A missed refresh can only let the claim expire, and a claimant that lost its claim re-checks when it holds.
	}
}

/** The live process that claimed the start of the session in `dir`, if any; a stale claim is broken on the way. */
export async function startClaimant(
	dir: string,
	probes: LockProbes & { readonly markUnproven?: boolean } = {},
): Promise<SessionHolder | undefined> {
	const path = join(dir, START_CLAIM);
	const claim = await inspectClaim(path, probes);
	if (claim.state === "stale") await breakStaleLock(path, claim.raw);
	if (claim.state !== "held" || claim.pid === undefined) return undefined;
	return {
		pid: claim.pid,
		cwd: parseCwd(claim.raw),
		...(probes.markUnproven === true && claim.unproven ? { unproven: true as const } : {}),
	};
}
