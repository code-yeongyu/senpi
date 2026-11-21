/**
 * The ensure lock of one endpoint: the one lock every operation that changes WHO serves a socket takes
 * first - `ensureHost` (start, reuse, upgrade), `handoffHost` (a forced handoff) and `host gc` (removal) -
 * so none of them ever acts on a state another one is halfway through changing.
 *
 * It is keyed by the socket's transport address rather than by any agent directory, so two
 * installations targeting one endpoint exclude each other, and on POSIX by the canonical spelling of
 * that address, so two spellings of one socket exclude each other too.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory, userPrivateDirectoryPath } from "../../utils/user-private-dir.ts";
import { canonicalEndpointPath } from "./host-daemon-paths.ts";
import { acquireOwnershipSafeLock, type OwnershipSafeLockOptions } from "./ownership-safe-lock.ts";
import { resolveSocketTransportAddress } from "./socket-transport.ts";

/** Each SQLite busy wait stays short: it blocks the event loop, so a same-process holder could never finish. */
const LOCK_BUSY_WAIT_MS = 100;

/**
 * Every endpoint lock of THIS user lives in `<tmpdir>/senpi-rpc-host-locks-<uid>` (senpi#6871): it was
 * `<tmpdir>/senpi-rpc-host-locks`, which on Linux is one `/tmp` directory for every user, so the first user created it
 * 0755 and every other user's host then died on `EACCES` creating its lock. Resolution and checks are
 * `utils/user-private-dir.ts`'s; the directory depends on the uid and `TMPDIR` only, which the daemon env allowlist
 * passes on, so a client and the host it started agree on it, and it never moves under a running host.
 */
const LOCK_DIRECTORY_NAME = "senpi-rpc-host-locks";

/** The endpoint lock every ensure of `socket` serializes on, without its `.lock` suffix. */
export function hostEnsureLockTarget(socket: string): string {
	return join(userPrivateDirectoryPath(LOCK_DIRECTORY_NAME), createSocketLockName(socket));
}

/**
 * The same target in the directory engines before senpi#6874 lock in, while an old engine of this user may still use
 * it (review L1): during an upgrade an old and a new engine serve one socket, and without this they would take two
 * different locks and fences. Only a real directory this user owns and that no one outside the user (see
 * `writableOnlyByThisUser`) can write into counts, so nothing planted is opened; it is never created (that would hand
 * the shared name back to one user), and win32 never moved. `undefined` when there is nothing to bridge.
 */
export async function legacyHostEnsureLockTarget(socket: string): Promise<string | undefined> {
	if (process.platform === "win32") return undefined;
	const directory = join(tmpdir(), LOCK_DIRECTORY_NAME);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch {
		// Absent, a symlink, or another user's: no old engine of this user can be locking there.
		return undefined;
	}
	try {
		const entry = await handle.stat();
		return entry.uid === process.getuid?.() && writableOnlyByThisUser(entry.mode, entry.gid)
			? join(directory, createSocketLockName(socket))
			: undefined;
	} finally {
		await handle.close();
	}
}

/**
 * Writable by its owner, never by others, and by its group only when that group is this user's own primary group:
 * under the umask 002 that user-private-group systems (Debian, Ubuntu) default to, an old engine created the legacy
 * directory 0775 with the user's own group. Bridging then trusts exactly who the old engine already trusted, and only
 * for the legacy copies; any other group or world write keeps the bridge off.
 */
function writableOnlyByThisUser(mode: number, gid: number): boolean {
	if ((mode & 0o200) === 0 || (mode & 0o002) !== 0) return false;
	return (mode & 0o020) === 0 || gid === process.getgid?.();
}

/** This user's lock directory made or proven, and the endpoint's lock target in it created; returns the target. */
export async function prepareHostEnsureLock(socket: string): Promise<string> {
	const lockTarget = hostEnsureLockTarget(socket);
	ensurePrivateDirectory(dirname(lockTarget));
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	return lockTarget;
}

/**
 * Takes one of `socket`'s locks (`.lock`, the ensure lock; `.fence.lock`, the senpi#4602 fence): this user's, then
 * the legacy one when it is bridged. Always in that order, and an old engine only ever takes the legacy one, so the
 * pair cannot deadlock. Both are released together; a failure on the second releases the first.
 */
export async function acquireEndpointLock(
	socket: string,
	suffix: ".lock" | ".fence.lock",
	options: OwnershipSafeLockOptions,
): Promise<() => Promise<void>> {
	const target = hostEnsureLockTarget(socket);
	ensurePrivateDirectory(dirname(target));
	const release = await acquireOwnershipSafeLock(`${target}${suffix}`, options);
	try {
		const legacy = await legacyHostEnsureLockTarget(socket);
		const releaseLegacy =
			legacy === undefined ? undefined : await acquireOwnershipSafeLock(`${legacy}${suffix}`, options);
		return async () => {
			try {
				await releaseLegacy?.();
			} finally {
				await release();
			}
		};
	} catch (cause) {
		await release();
		throw cause;
	}
}

export async function acquireHostEnsureLock(socket: string, waitMs: number): Promise<() => Promise<void>> {
	await prepareHostEnsureLock(socket);
	return acquireEndpointLock(socket, ".lock", hostEnsureLockOptions(waitMs));
}

export function hostEnsureLockOptions(waitMs: number) {
	return {
		retries: { retries: Math.ceil(waitMs / LOCK_BUSY_WAIT_MS), minTimeout: 20, maxTimeout: LOCK_BUSY_WAIT_MS },
	} as const;
}

function createSocketLockName(socket: string): string {
	return createHash("sha256").update(socketLockAddress(socket), "utf8").digest("hex").slice(0, 32);
}

/**
 * One address per PHYSICAL socket: the canonical endpoint path (`/tmp` vs `/private/tmp`, a symlinked
 * agent directory), the identity the daemon directory is named by, so a gc holding one spelling's lock
 * can never unlink the socket an ensure through the other spelling just bound. Named pipes and abstract
 * sockets have no directory to resolve.
 */
function socketLockAddress(socket: string): string {
	if (process.platform === "win32" || socket.startsWith("\0")) {
		return resolveSocketTransportAddress(socket, process.platform);
	}
	return canonicalEndpointPath(socket);
}
