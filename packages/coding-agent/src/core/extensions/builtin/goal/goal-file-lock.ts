import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import {
	FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
	FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS,
	isLockError,
} from "../../../lockfile-policy.ts";
import { serializeByKey } from "../../../session-sidecar-store.ts";
import { goalFilePath, writeGoalFile } from "./persistence.ts";
import type { Goal, GoalStoreRef } from "./types.ts";

/**
 * One policy for every goal-lock contender. A goal read-modify-write takes milliseconds, so a
 * 10s stale window never mistakes a live holder (mtime refreshed every 2s) for a dead one,
 * while a holder killed mid-mutation is reclaimed within ~10s. The wait budget exceeds the
 * stale window, so waiters ride through a crashed holder instead of failing.
 */
export const GOAL_LOCK_OPTIONS = { realpath: false, stale: 10_000, update: 2_000, retries: 0 } as const;
export const GOAL_LOCK_WAIT_BUDGET_MS = 15_000;

export class GoalStoreBusyError extends Error {
	readonly path: string;
	readonly waitedMs: number;

	constructor(path: string, waitedMs: number, cause?: unknown) {
		super(
			`Goal store is busy: lock on ${path} was held for ${waitedMs}ms. ` +
				"Another process may be updating the goal; close unused sessions if contention persists.",
			{ cause },
		);
		this.name = "GoalStoreBusyError";
		this.path = path;
		this.waitedMs = waitedMs;
	}
}

export class GoalStoreLockCompromisedError extends Error {
	readonly path: string;

	constructor(path: string, cause?: unknown) {
		super(
			`Goal store lock on ${path} was compromised: another process reclaimed it. ` +
				"The stale write was rejected to preserve the newer goal state.",
			{ cause },
		);
		this.name = "GoalStoreLockCompromisedError";
		this.path = path;
	}
}

/** Capabilities a mutation receives while it holds the goal lock. */
export interface HeldGoalLock {
	/** Throws GoalStoreLockCompromisedError when the lock was reclaimed; call before any side write. */
	assertHeld(): void;
	/** Writes the goal file only while the lock is still held. */
	write(goal: Goal | null): Promise<void>;
}

/**
 * The lock directory sits beside the goal file under a fixed-length name. proper-lockfile's
 * default `<file>.lock` would overflow NAME_MAX for a goal whose encoded basename is already
 * at the 255-byte component limit, which the store supports.
 */
export function goalLockFilePath(ref: GoalStoreRef): string {
	const filePath = goalFilePath(ref);
	const digest = createHash("sha256").update(basename(filePath)).digest("hex").slice(0, 40);
	return join(dirname(filePath), `.goal-lock-${digest}`);
}

async function acquireGoalLock(
	filePath: string,
	lockfilePath: string,
): Promise<{ release: () => Promise<void>; isCompromised: () => unknown }> {
	// realpath:false locks without the goal file existing; creating a placeholder goal file here
	// would make migrateLegacyGoalFile skip a pending legacy import.
	await mkdir(dirname(filePath), { recursive: true });

	let compromise: { error: unknown } | undefined;
	const startedAt = Date.now();
	let attempt = 0;
	while (true) {
		try {
			const release = await lockfile.lock(filePath, {
				...GOAL_LOCK_OPTIONS,
				lockfilePath,
				onCompromised: (error: Error) => {
					compromise = { error };
				},
			});
			return { release, isCompromised: () => compromise };
		} catch (error) {
			if (!isLockError(error)) throw error;
			const waitedMs = Date.now() - startedAt;
			if (waitedMs >= GOAL_LOCK_WAIT_BUDGET_MS) {
				throw new GoalStoreBusyError(filePath, waitedMs, error);
			}
			const delayMs = Math.min(
				FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS * 2 ** attempt,
				FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
				GOAL_LOCK_WAIT_BUDGET_MS - waitedMs,
			);
			attempt += 1;
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

/**
 * Serializes a goal mutation both within and across processes.
 *
 * The in-process promise tail (serializeByKey) runs first, so a process has at most one lock
 * acquisition in flight per goal. The file lock then guards the read-modify-write against
 * other processes, and `held.write` refuses to write once the lock has been reclaimed.
 */
export function withGoalFileLock<T>(ref: GoalStoreRef, fn: (held: HeldGoalLock) => Promise<T>): Promise<T> {
	const filePath = goalFilePath(ref);
	return serializeByKey(filePath, async () => {
		const { release, isCompromised } = await acquireGoalLock(filePath, goalLockFilePath(ref));
		const assertHeld = () => {
			const compromise = isCompromised();
			if (compromise) throw new GoalStoreLockCompromisedError(filePath, compromise);
		};
		try {
			return await fn({
				assertHeld,
				write: async (goal) => {
					assertHeld();
					await writeGoalFile(ref, goal);
				},
			});
		} finally {
			try {
				await release();
			} catch {
				// A compromised or already-removed lock cannot be released; the mutation result stands.
			}
		}
	});
}
