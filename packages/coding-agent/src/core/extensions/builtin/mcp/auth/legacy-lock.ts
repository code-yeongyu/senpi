import { closeSync, openSync, rmSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { safeDelay } from "../wrap.ts";

/**
 * Shares the existing O_EXCL file with synchronous migrators without blocking the event loop: waiting is
 * asynchronous, but the lock is taken, used by `critical` and released in one synchronous step. A lock held
 * across an await would let a synchronous reader in the same process spin on it with the event loop blocked,
 * so the holder could never release it and every caller froze until the lock went stale (senpi#3546).
 */
export async function withLegacyLock<T>(path: string, stale: number, critical: () => T): Promise<T> {
	const deadline = Date.now() + stale;
	for (;;) {
		const file = tryOpen(path);
		if (file !== undefined) {
			try {
				return critical();
			} finally {
				try {
					closeSync(file);
				} finally {
					rmSync(path, { force: true });
				}
			}
		}
		await waitForHolder(path, stale, deadline);
	}
}

/** Thrown when the lock itself cannot be taken; errors from the critical section propagate unchanged. */
export class LegacyLockAcquireError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "LegacyLockAcquireError";
	}
}

function tryOpen(path: string): number | undefined {
	try {
		return openSync(path, "wx", 0o600);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined;
		throw new LegacyLockAcquireError(error);
	}
}

async function waitForHolder(path: string, stale: number, deadline: number): Promise<void> {
	try {
		const age = Date.now() - (await stat(path)).mtimeMs;
		if (age >= stale) {
			await rm(path, { force: true });
			return;
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw new LegacyLockAcquireError(error);
	}
	if (Date.now() >= deadline) {
		throw new LegacyLockAcquireError(new Error("Legacy OAuth migration lock acquisition timed out"));
	}
	await safeDelay(20);
}
