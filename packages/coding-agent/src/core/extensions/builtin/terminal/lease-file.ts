/**
 * File-level primitives for the terminal lease. On a filesystem with hard links a lease file is
 * never visible half-written: it is written to a private temp file first and then published with
 * `link` (exclusive: fails with EEXIST when a lease exists) or `rename` (replace). Every removal of
 * a lease, by an acquire or by the GC, goes through `reclaimInspected`: under an exclusive
 * `<lease>.lock`, and only while the file still holds exactly the record that was judged stale, so
 * a fresh lease another process just published is never deleted. A reclaim lock records the
 * holder's identity (pid, boot and start instant); it is broken only when that process is gone or its
 * pid now belongs to another process, and only if it still holds the record that was judged stale.
 */

import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { ownProcessStartedAtMs, processBootAtMs, sameBoot, sameProcessStart } from "./process-identity.ts";
import { readProcessStartMs as defaultReadProcessStartMs } from "./process-start-probe.ts";

export function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

export async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

export async function readLeaseText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** Options for publishing a lease file. */
export interface PublishOptions {
	/** File mode of the published file (before umask); defaults to 0o666 like `open`. */
	readonly mode?: number;
}

async function writeTemp(path: string, content: string, mode: number | undefined): Promise<string> {
	const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	const file = await open(temp, "wx", mode);
	try {
		await file.writeFile(content, "utf8");
	} finally {
		await file.close();
	}
	return temp;
}

/** Publish `content` at `path` only if nothing is there; throws EEXIST otherwise. Never half-written. */
export async function publishExclusive(path: string, content: string, options: PublishOptions = {}): Promise<void> {
	const temp = await writeTemp(path, content, options.mode);
	try {
		await link(temp, path);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EPERM") throw error;
		// A filesystem without hard links: fall back to an exclusive create (briefly visible empty).
		const file = await open(path, "wx", options.mode);
		try {
			await file.writeFile(content, "utf8");
		} finally {
			await file.close();
		}
	} finally {
		await unlinkIfPresent(temp);
	}
}

export async function publishReplace(path: string, content: string, options: PublishOptions = {}): Promise<void> {
	const temp = await writeTemp(path, content, options.mode);
	try {
		await rename(temp, path);
	} catch (error) {
		await unlinkIfPresent(temp);
		throw error;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

export interface LockProbes {
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly readProcessStartMs?: (pid: number) => Promise<number | undefined>;
}

/** Who holds a reclaim lock: the same identity a lease records, so a reused pid is never mistaken for it. */
export interface ReclaimLockHolder {
	readonly pid: number;
	readonly bootAtMs: number;
	readonly processStartedAtMs: number;
}

type LockState =
	| { readonly state: "free" }
	| { readonly state: "held"; readonly holder?: ReclaimLockHolder }
	| { readonly state: "stale"; readonly raw: string };

/** A lock that cannot even be parsed was left by a crash mid-write; past this age it is abandoned. */
const UNREADABLE_LOCK_STALE_MS = 30_000;

function readLockHolder(raw: string): ReclaimLockHolder | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		if (!("pid" in parsed) || !("bootAtMs" in parsed) || !("processStartedAtMs" in parsed)) return undefined;
		const { pid, bootAtMs, processStartedAtMs } = parsed;
		if (typeof pid !== "number" || typeof bootAtMs !== "number" || typeof processStartedAtMs !== "number") {
			return undefined;
		}
		return { pid, bootAtMs, processStartedAtMs };
	} catch {
		return undefined;
	}
}

/** Whether a reclaim lock is held by the very process that wrote it; a dead or reused pid is stale. */
export async function reclaimLockState(lock: string, probes: LockProbes = {}): Promise<LockState> {
	const raw = await readLeaseText(lock);
	if (raw === undefined) return { state: "free" };
	const holder = readLockHolder(raw);
	if (holder === undefined) {
		const age = await stat(lock).then(
			(info) => Date.now() - info.mtimeMs,
			() => 0,
		);
		return age > UNREADABLE_LOCK_STALE_MS ? { state: "stale", raw } : { state: "held" };
	}
	if (!sameBoot(holder.bootAtMs, processBootAtMs())) return { state: "stale", raw };
	if (holder.pid === process.pid) {
		// Our own pid: held only by this very process (another reclaim in flight here), never by a
		// crashed earlier process whose pid this one now wears.
		return sameProcessStart(holder.processStartedAtMs, ownProcessStartedAtMs())
			? { state: "held", holder }
			: { state: "stale", raw };
	}
	if (!(probes.isProcessAlive ?? pidAlive)(holder.pid)) return { state: "stale", raw };
	const observed = await (probes.readProcessStartMs ?? defaultReadProcessStartMs)(holder.pid).catch(() => undefined);
	if (observed === undefined || sameProcessStart(holder.processStartedAtMs, observed))
		return { state: "held", holder };
	return { state: "stale", raw };
}

/** Remove a stale lock only if it still holds `raw`; a lock someone took meanwhile is put back. */
export async function breakStaleLock(lock: string, raw: string): Promise<void> {
	const aside = `${lock}.${process.pid}.${randomUUID().slice(0, 8)}.broken`;
	try {
		await rename(lock, aside);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	const moved = await readFile(aside, "utf8");
	if (moved !== raw) {
		try {
			await publishExclusive(lock, moved);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
	}
	await unlinkIfPresent(aside);
}

async function takeReclaimLock(lock: string, probes: LockProbes): Promise<string | { holder?: ReclaimLockHolder }> {
	const mine = JSON.stringify({
		pid: process.pid,
		bootAtMs: processBootAtMs(),
		processStartedAtMs: ownProcessStartedAtMs(),
	});
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await publishExclusive(lock, mine);
			return mine;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const seen = await reclaimLockState(lock, probes);
		if (seen.state === "held") return { holder: seen.holder };
		if (seen.state === "stale") await breakStaleLock(lock, seen.raw);
	}
	return {};
}

export type ReclaimOutcome =
	| { readonly outcome: "removed" | "changed" }
	| { readonly outcome: "busy"; readonly holder?: ReclaimLockHolder };

/**
 * Remove the lease at `path` only if it still holds `inspected`: `removed`, `changed` (another
 * process replaced it meanwhile; left alone), or `busy` with the live process reclaiming it now.
 */
export async function reclaimInspected(
	path: string,
	inspected: string,
	probes: LockProbes = {},
): Promise<ReclaimOutcome> {
	const lock = `${path}.lock`;
	const taken = await takeReclaimLock(lock, probes);
	if (typeof taken !== "string") return { outcome: "busy", ...(taken.holder ? { holder: taken.holder } : {}) };
	try {
		if ((await readLeaseText(path)) !== inspected) return { outcome: "changed" };
		await unlinkIfPresent(path);
		return { outcome: "removed" };
	} finally {
		// Release only our own lock: one broken while we held it may now belong to someone else.
		if ((await readLeaseText(lock)) === taken) await unlinkIfPresent(lock);
	}
}
