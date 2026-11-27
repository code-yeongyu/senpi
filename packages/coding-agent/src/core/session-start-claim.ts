import { readFileSync, unlinkSync } from "node:fs";
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

/**
 * The start claim of a session (senpi#5988). Startup admission and the holder record a starting process publishes
 * are far apart: extensions and models load in between. A start therefore claims the session first, exclusively, in
 * `<holders dir>/start.claim`, and that claim counts as a holder until the process publishes its holder record or
 * exits. Of two simultaneous starts exactly one creates the file; the other finds a live holder, as a later start
 * finds the first one's record. The claim carries the same identity as a holder record, so the claim of a crashed or
 * reused pid is stale and is broken by the next reader. It is published like the move lock (`link`, or an exclusive
 * create where a filesystem has no hard links), so it holds on win32 too.
 */

const START_CLAIM = "start.claim";
// A start that has not published its holder record this long after claiming (a hung load) no longer keeps others
// out. Breaking its claim is safe: a claimant that finds its claim gone re-checks after publishing (`holdSessionFile`).
const START_CLAIM_STALE_MS = 5 * 60_000;
// A live claimant keeps its claim fresh while its start is still loading, so only a stopped process lets it expire.
const START_CLAIM_REFRESH_MS = 60_000;

interface OwnClaim {
	readonly path: string;
	readonly raw: string;
	readonly refresh: ReturnType<typeof setInterval>;
}

// This process's claims by session id: the hold taken for the session drops its claim even after a rebind moved it.
const ownClaims = new Map<string, OwnClaim>();
let exitCleanupInstalled = false;

function ownsClaimSync(claim: OwnClaim): boolean {
	try {
		return readFileSync(claim.path, "utf8") === claim.raw;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

/** Removes a holders directory once nothing is left in it; one another process just wrote to stays. */
export async function removeEmptyDir(dir: string): Promise<void> {
	try {
		await rmdir(dir);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	}
}

function installExitCleanup(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", () => {
		for (const claim of ownClaims.values()) if (ownsClaimSync(claim)) unlinkSync(claim.path);
	});
}

/**
 * Drops this process's start claim on `sessionId`: after its holder record is published, or when the start does not
 * open the session. `lost` means the claim was this process's but another process broke it meanwhile.
 */
export async function dropStartClaim(sessionId: string): Promise<"none" | "dropped" | "lost"> {
	const claim = ownClaims.get(sessionId);
	if (claim === undefined) return "none";
	ownClaims.delete(sessionId);
	clearInterval(claim.refresh);
	if ((await readLeaseText(claim.path)) !== claim.raw) return "lost";
	await unlinkIfPresent(claim.path);
	await removeEmptyDir(dirname(claim.path));
	return "dropped";
}

/** The claim's text when it no longer keeps others out: its process is gone, or it claimed too long ago. */
async function staleClaim(path: string, probes: LockProbes): Promise<string | undefined> {
	const raw = await readLeaseText(path);
	if (raw === undefined) return undefined;
	const state = await reclaimLockState(path, probes);
	if (state.state === "stale") return state.raw;
	const claimedAt = await stat(path).then(
		(info) => info.mtimeMs,
		() => undefined,
	);
	return claimedAt !== undefined && Date.now() - claimedAt > START_CLAIM_STALE_MS ? raw : undefined;
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
	// A finishing move removes the emptied directory (senpi#5618), and a broken stale claim frees the file: each is
	// one more round. Three rounds without a decision means other starts keep winning; one of them is the holder.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await mkdir(dir, { recursive: true });
			await publishExclusive(path, identity);
			const refresh = setInterval(() => void refreshClaim(path, identity), START_CLAIM_REFRESH_MS);
			refresh.unref();
			ownClaims.set(sessionId, { path, raw: identity, refresh });
			installExitCleanup();
			return true;
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT") continue;
			if (code !== "EEXIST") throw error;
		}
		const stale = await staleClaim(path, {});
		if (stale === undefined && (await readLeaseText(path)) !== undefined) return false;
		if (stale !== undefined) await breakStaleLock(path, stale);
	}
	return false;
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

function claimCwd(raw: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || !("cwd" in parsed)) return undefined;
		return typeof parsed.cwd === "string" ? parsed.cwd : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/** The live process that claimed the start of the session in `dir`, if any; a stale claim is broken on the way. */
export async function startClaimant(
	dir: string,
	probes: LockProbes & { readonly markUnproven?: boolean } = {},
): Promise<SessionHolder | undefined> {
	const path = join(dir, START_CLAIM);
	const stale = await staleClaim(path, probes);
	if (stale !== undefined) {
		await breakStaleLock(path, stale);
		return undefined;
	}
	const raw = await readLeaseText(path);
	if (raw === undefined) return undefined;
	const state = await reclaimLockState(path, probes);
	if (state.state !== "held" || state.holder === undefined) return undefined;
	return {
		pid: state.holder.pid,
		cwd: claimCwd(raw),
		...(probes.markUnproven === true && state.unproven === true ? { unproven: true as const } : {}),
	};
}
