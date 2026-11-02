import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { link, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const LOCK_FILE = ".install.lock";
const REAP_PREFIX = ".install.lock.reap.";
const RECHECK_MS = 500;
// An unparseable lock can only come from a crash in an older version's create-then-write; it is stale once old.
const UNREADABLE_STALE_MS = 5_000;
const WAIT_NOTICE_MS = 30_000;

type Holder = { readonly pid: number; readonly host: string; readonly nonce: string };

export type LockWaitNotice = {
	readonly holder: { readonly pid: number; readonly host: string } | undefined;
	readonly waitedMs: number;
};

/**
 * Serialises installs into one environment root across sessions and processes.
 *
 * The lock file is published complete (written to a unique temp file, then `link`ed into place, which fails
 * if a lock exists), so it is never seen empty. A lock whose holder is a dead process on this host, or
 * that is unreadable and old, is stale. Each lock incarnation has its own key (its holder's nonce), and
 * only the waiter that exclusively creates the reap claim for that key may remove it, after re-reading the
 * lock under the claim and finding the same incarnation. A stale incarnation's holder is dead and nobody
 * else may remove it, so it can't change between that re-read and the removal: a live lock is never
 * deleted. A claimer that dies passes the claim on to the next claim in the chain.
 */
export async function withRootLock<T>(
	base: string,
	fn: () => Promise<T>,
	signal?: AbortSignal,
	onWait?: (notice: LockWaitNotice) => void,
): Promise<T> {
	const path = join(base, LOCK_FILE);
	const mine: Holder = { pid: process.pid, host: hostname(), nonce: randomUUID() };
	const started = Date.now();
	let noticed = false;
	for (;;) {
		signal?.throwIfAborted();
		if (await tryCreate(base, path, mine)) break;
		if (await takeOverIfStale(base, path)) continue;
		if (!noticed && Date.now() - started >= WAIT_NOTICE_MS) {
			noticed = true;
			const holder = await readHolder(path);
			onWait?.({ holder: holder && { pid: holder.pid, host: holder.host }, waitedMs: Date.now() - started });
		}
		await waitForRelease(base, path, signal);
	}
	try {
		return await fn();
	} finally {
		const holder = await readHolder(path);
		if (holder?.nonce === mine.nonce) await rm(path, { force: true });
	}
}

async function tryCreate(base: string, path: string, holder: Holder): Promise<boolean> {
	const temp = join(base, `.install.lock.${holder.nonce}`);
	await writeFile(temp, JSON.stringify(holder), { mode: 0o600 });
	try {
		await link(temp, path);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temp, { force: true });
	}
}

async function takeOverIfStale(base: string, path: string): Promise<boolean> {
	const key = await staleKey(path);
	if (key === undefined) return false;
	const claim = await claimReap(base, key);
	if (claim === undefined) return false;
	try {
		// Under the claim nobody else may remove this incarnation, and its holder is dead, so it is still the
		// lock judged stale exactly when it still has the same key.
		if ((await staleKey(path)) !== key) return false;
		await rm(path, { force: true });
		await removeDeadClaims(base, key);
		return true;
	} finally {
		await rm(claim, { force: true });
	}
}

/** Once the incarnation is gone, its claims only matter to waiters that will find a different lock. */
async function removeDeadClaims(base: string, key: string): Promise<void> {
	const prefix = `${REAP_PREFIX}${key}.`;
	for (const name of (await readdir(base)).filter((entry) => entry.startsWith(prefix))) {
		const holder = await readHolder(join(base, name));
		if (holder !== undefined && holder.host === hostname() && !isAlive(holder.pid))
			await rm(join(base, name), { force: true });
	}
}

/**
 * Creates the next free reap claim for one lock incarnation: `<key>.0`, or the claim after the last one
 * whose holder died. Returns undefined when a live waiter already holds it.
 */
async function claimReap(base: string, key: string): Promise<string | undefined> {
	for (let depth = 0; ; depth++) {
		const claim = join(base, `${REAP_PREFIX}${key}.${depth}`);
		if (await tryCreate(base, claim, { pid: process.pid, host: hostname(), nonce: randomUUID() })) return claim;
		const holder = await readHolder(claim);
		// Gone again (its holder finished): the caller re-reads the lock and retries.
		if (holder === undefined) return undefined;
		if (holder.host !== hostname() || isAlive(holder.pid)) return undefined;
	}
}

async function reapInProgress(base: string, key: string): Promise<boolean> {
	const prefix = `${REAP_PREFIX}${key}.`;
	let names: string[];
	try {
		names = (await readdir(base)).filter((name) => name.startsWith(prefix));
	} catch {
		return false;
	}
	for (const name of names) {
		const holder = await readHolder(join(base, name));
		if (holder !== undefined && holder.host === hostname() && isAlive(holder.pid)) return true;
	}
	return false;
}

/** The incarnation key of a stale lock (its holder's nonce, or its inode when unreadable), else undefined. */
async function staleKey(path: string): Promise<string | undefined> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	const holder = parseHolder(content);
	if (holder !== undefined && (holder.host !== hostname() || isAlive(holder.pid))) return undefined;
	if (holder !== undefined && /^[\w-]+$/u.test(holder.nonce)) return holder.nonce;
	try {
		const info = await stat(path);
		// A dead holder's lock without a usable nonce, or an unreadable old one, is keyed by its inode.
		return holder !== undefined || Date.now() - info.mtimeMs > UNREADABLE_STALE_MS ? `ino${info.ino}` : undefined;
	} catch {
		return undefined;
	}
}

async function readHolder(path: string): Promise<Holder | undefined> {
	try {
		return parseHolder(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

function parseHolder(content: string): Holder | undefined {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const pid = "pid" in value ? value.pid : undefined;
	const host = "host" in value ? value.host : undefined;
	const nonce = "nonce" in value ? value.nonce : undefined;
	return typeof pid === "number" && typeof host === "string"
		? { pid, host, nonce: typeof nonce === "string" ? nonce : "" }
		: undefined;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Wakes when the lock file goes away; the periodic recheck covers dropped file-watch events and staleness. */
function waitForRelease(base: string, path: string, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const watcher = watch(base, () => check());
		const timer = setInterval(() => check(), RECHECK_MS);
		const onAbort = () => done(() => reject(signal?.reason));
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		function done(settle: () => void): void {
			if (settled) return;
			settled = true;
			watcher.close();
			clearInterval(timer);
			signal?.removeEventListener("abort", onAbort);
			settle();
		}
		function check(): void {
			void stat(path).then(
				// A stale lock is worth retrying only when no live waiter is already reaping it; otherwise wait.
				() =>
					staleKey(path).then(
						async (key) => key !== undefined && !(await reapInProgress(base, key)) && done(resolve),
					),
				() => done(resolve),
			);
		}
		// An abort during the claim inspection that led here fired before this listener existed.
		if (signal?.aborted) {
			onAbort();
			return;
		}
		// The holder may have released between the failed create and the watcher starting; no event would follow.
		check();
	});
}
