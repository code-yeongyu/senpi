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
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory, userPrivateDirectoryPath } from "../../utils/user-private-dir.ts";
import { canonicalEndpointPath } from "./host-daemon-paths.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";
import { resolveSocketTransportAddress } from "./socket-transport.ts";

/** Each SQLite busy wait stays short: it blocks the event loop, so a same-process holder could never finish. */
const LOCK_BUSY_WAIT_MS = 100;

/**
 * Every endpoint lock of THIS user lives in one directory only that user owns (senpi#6871): it was
 * `<tmpdir>/senpi-rpc-host-locks`, which on Linux is one `/tmp` directory for every user, so the first user created it
 * 0755 and every other user's host then died on `EACCES` creating its lock. The resolution and the checks are
 * `utils/user-private-dir.ts`'s; both inputs (`TMPDIR`, `XDG_*`) are environment the daemon env allowlist passes on,
 * so a client and the host it started agree on the directory.
 */
const LOCK_DIRECTORY_NAME = "senpi-rpc-host-locks";

/** The endpoint lock every ensure of `socket` serializes on, without its `.lock` suffix. */
export function hostEnsureLockTarget(socket: string): string {
	return join(userPrivateDirectoryPath(LOCK_DIRECTORY_NAME), createSocketLockName(socket));
}

/** This user's lock directory made or proven, and the endpoint's lock target in it created; returns the target. */
export async function prepareHostEnsureLock(socket: string): Promise<string> {
	const lockTarget = hostEnsureLockTarget(socket);
	ensurePrivateDirectory(dirname(lockTarget));
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	return lockTarget;
}

export async function acquireHostEnsureLock(socket: string, waitMs: number): Promise<() => Promise<void>> {
	const lockTarget = await prepareHostEnsureLock(socket);
	return acquireOwnershipSafeLock(`${lockTarget}.lock`, hostEnsureLockOptions(waitMs));
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
