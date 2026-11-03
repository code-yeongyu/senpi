import { existsSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DeviceFileError } from "@earendil-works/pi-agent-core";

/**
 * The memory component's git-activity lock, held by a hand around a `run` (S40 PR 2, design v2.4). Every memory git
 * run holds a SHARED flock on its identity's lock file and hands the descriptor to git as fd 3, so git and everything it
 * starts keep it; the stranded-lock sweep's EXCLUSIVE flock then fails while any of them lives.
 */

export const GIT_ACTIVITY_LOCK_NAME = "git-activity.flock";
export const GIT_ACTIVITY_SHARED_WAIT_MS = 10_000;
const RETRY_MS = 5;
const LOCK_SH = 1;
const LOCK_NB = 4;

/** `flock(2)` and the errno it left; `undefined` when this runtime cannot call it at all. */
export type Flock = (fd: number, operation: number) => { readonly rc: number; readonly errno: number };

export type FlockClass = "busy" | "no-lock" | "failed";

/**
 * The kernel-lock ruling: only EWOULDBLOCK/EAGAIN is busy (retried); ENOLCK, EOPNOTSUPP and ENOSYS mean no lock is
 * possible here and the run falls back to the pre-lock behaviour; anything else is a typed failure, never idle.
 */
export function classifyFlockErrno(errno: number): FlockClass {
	const { EAGAIN, EWOULDBLOCK, ENOLCK, EOPNOTSUPP, ENOSYS } = osConstants.errno;
	if (errno === EAGAIN || errno === EWOULDBLOCK) return "busy";
	if (errno === ENOLCK || errno === EOPNOTSUPP || errno === ENOSYS) return "no-lock";
	return "failed";
}

/** `<root>/agents/<id>/repo` -> `<root>/agents/<id>/runtime/locks`; any other directory has no activity lock. */
export function identityLocksDir(repoDir: string): string | undefined {
	const repo = resolve(repoDir);
	if (basename(repo) !== "repo" || basename(dirname(dirname(repo))) !== "agents") return undefined;
	return join(dirname(repo), "runtime", "locks");
}

export interface ActivityHold {
	/** The descriptor to pass to git as fd 3; `undefined` when no lock is held. */
	readonly fd: number | undefined;
	release(): Promise<void>;
}

const NO_HOLD: ActivityHold = { fd: undefined, release: async () => {} };
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Takes the shared activity lock for a `run` in `cwd`. The lock file is opened only when its directory already exists
 * (a late git operation must never recreate a removed identity tree, so a missing directory is `not_found`). No `flock`
 * in this runtime (`flock` undefined) is the ENOSYS case: no hold, as the memory component does without one.
 */
export async function holdActivityLock(
	cwd: string,
	flock: Flock | undefined,
	waitMs = GIT_ACTIVITY_SHARED_WAIT_MS,
): Promise<ActivityHold> {
	const locksDir = identityLocksDir(cwd);
	if (locksDir === undefined || flock === undefined) return NO_HOLD;
	if (!existsSync(locksDir)) throw new DeviceFileError("not_found", `the identity's locks directory does not exist`);
	const handle: FileHandle = await open(
		join(locksDir, GIT_ACTIVITY_LOCK_NAME),
		fsConstants.O_RDWR | fsConstants.O_CREAT,
		0o600,
	);
	const deadline = Date.now() + waitMs;
	try {
		for (;;) {
			const { rc, errno } = flock(handle.fd, LOCK_SH | LOCK_NB);
			if (rc === 0) return { fd: handle.fd, release: () => handle.close() };
			const kind = classifyFlockErrno(errno);
			if (kind === "no-lock") {
				await handle.close();
				return NO_HOLD;
			}
			if (kind === "failed")
				throw new DeviceFileError("io", `flock on the git-activity lock failed (errno ${errno})`);
			if (Date.now() >= deadline)
				throw new DeviceFileError("io", `the git-activity lock stayed exclusively held for ${waitMs} ms`);
			await delay(RETRY_MS);
		}
	} catch (error) {
		await handle.close();
		throw error;
	}
}
