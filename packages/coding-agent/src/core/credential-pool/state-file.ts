import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type HeldFileLock, lockWithLossHandling } from "../file-lock.ts";
import { CredentialStoreBusyError, FILE_STORAGE_LOCK_OPTIONS, isLockError } from "../lockfile-policy.ts";

const FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

// Critical sections here last a few milliseconds, so a contender re-checks often;
// full jitter keeps processes polling in lockstep from starving one another.
const RETRY_MIN_DELAY_MS = 25;
const RETRY_MAX_DELAY_MS = 250;

/** Same-process callers queue here in arrival order, so only the head contends for the file lock. */
const queueTails = new Map<string, Promise<void>>();

/** The file's content, or undefined when it does not exist yet. */
export function readStateFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

// Windows refuses to replace a file another process (antivirus, the indexer, a
// lock-free reader) has open for a moment; those codes clear on their own.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const;

function isTransientRenameError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		TRANSIENT_RENAME_CODES.has(error.code)
	);
}

/** Renames over the target, retrying a transiently refused replace; a refusal that outlasts the retries reads as a busy store. */
async function replaceFile(temporary: string, path: string): Promise<void> {
	const startedAt = Date.now();
	for (const delayMs of [...RENAME_RETRY_DELAYS_MS, undefined]) {
		try {
			renameSync(temporary, path);
			return;
		} catch (error) {
			if (!isTransientRenameError(error)) throw error;
			if (delayMs === undefined) throw new CredentialStoreBusyError(path, Date.now() - startedAt, error);
			await sleep(delayMs);
		}
	}
}

/**
 * Stages the document beside the file and renames it over the target, so a
 * reader that takes no lock always sees one complete document: the previous
 * one or the next one, never a torn write. Writers stay serialized by the
 * lock the caller holds, so the pid-suffixed temp cannot collide.
 */
export async function writeStateFileAtomic(path: string, content: string): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, content, FILE_WRITE_OPTIONS);
		if (existsSync(path)) chmodSync(temporary, statSync(path).mode & 0o777);
		await replaceFile(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Resolves true when `turn` settles before `deadline`, false when the deadline passes first. */
async function reachedBefore(turn: Promise<void>, deadline: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
	});
	try {
		return await Promise.race([turn.then(() => true), expired]);
	} finally {
		clearTimeout(timer);
	}
}

async function lockFileBefore(path: string, startedAt: number, deadline: number): Promise<HeldFileLock> {
	let attempt = 0;
	while (true) {
		try {
			return await lockWithLossHandling(path, FILE_STORAGE_LOCK_OPTIONS);
		} catch (error) {
			if (!isLockError(error)) throw error;
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw new CredentialStoreBusyError(path, Date.now() - startedAt, error);
			const ceilingMs = Math.min(RETRY_MIN_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
			attempt++;
			await sleep(Math.min(remainingMs, Math.max(1, Math.random() * ceilingMs)));
		}
	}
}

/**
 * Waits for the file lock within `budgetMs` (queueing behind same-process
 * callers counts against it), then fails naming the lock and the wait.
 */
export async function acquireStateFileLock(
	path: string,
	budgetMs: number,
): Promise<Pick<HeldFileLock, "release" | "assertHeld">> {
	const startedAt = Date.now();
	const deadline = startedAt + budgetMs;
	const previous = queueTails.get(path) ?? Promise.resolve();
	let endTurn = (): void => {};
	const turn = new Promise<void>((resolve) => {
		endTurn = resolve;
	});
	const tail = previous.then(() => turn);
	queueTails.set(path, tail);
	const finishTurn = (): void => {
		endTurn();
		if (queueTails.get(path) === tail) queueTails.delete(path);
	};
	try {
		if (!(await reachedBefore(previous, deadline))) {
			throw new CredentialStoreBusyError(path, Date.now() - startedAt);
		}
		const held = await lockFileBefore(path, startedAt, deadline);
		return {
			assertHeld: held.assertHeld,
			release: async () => {
				try {
					await held.release();
				} finally {
					finishTurn();
				}
			},
		};
	} catch (error) {
		finishTurn();
		throw error;
	}
}
