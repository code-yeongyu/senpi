import { watch } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const LOCK_FILE = ".install.lock";
const RECHECK_MS = 500;

type Holder = { readonly pid: number; readonly host: string };

/**
 * Serialises installs into one environment root across sessions and processes. The holder is recorded in
 * an exclusively created lock file; a lock left by a process on this host that no longer exists is taken
 * over, while one held by a live process (or by another host) is waited for.
 */
export async function withRootLock<T>(base: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const path = join(base, LOCK_FILE);
	for (;;) {
		signal?.throwIfAborted();
		if (await tryCreate(path)) break;
		const holder = await readHolder(path);
		if (holder !== undefined && holder.host === hostname() && !isAlive(holder.pid)) {
			await rm(path, { force: true });
			continue;
		}
		await waitForRelease(base, path, signal);
	}
	try {
		return await fn();
	} finally {
		await rm(path, { force: true });
	}
}

async function tryCreate(path: string): Promise<boolean> {
	try {
		const file = await open(path, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
		} finally {
			await file.close();
		}
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}

async function readHolder(path: string): Promise<Holder | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const pid = "pid" in value ? value.pid : undefined;
		const host = "host" in value ? value.host : undefined;
		return typeof pid === "number" && typeof host === "string" ? { pid, host } : undefined;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

/** Wakes on the lock file's removal; the periodic recheck covers file-watch events the OS drops. */
function waitForRelease(base: string, path: string, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const watcher = watch(base, () => finish());
		const timer = setInterval(() => finish(), RECHECK_MS);
		const onAbort = () => done(() => reject(signal?.reason));
		signal?.addEventListener("abort", onAbort, { once: true });
		function done(settle: () => void): void {
			watcher.close();
			clearInterval(timer);
			signal?.removeEventListener("abort", onAbort);
			settle();
		}
		function finish(): void {
			void readHolder(path).then((holder) => {
				if (holder === undefined) done(resolve);
			});
		}
	});
}
