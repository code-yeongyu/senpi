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
import { constants, statSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalEndpointPath } from "./host-daemon-paths.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";
import { resolveSocketTransportAddress } from "./socket-transport.ts";

/** Each SQLite busy wait stays short: it blocks the event loop, so a same-process holder could never finish. */
const LOCK_BUSY_WAIT_MS = 100;

const LOCK_DIRECTORY_NAME = "senpi-rpc-host-locks";
const PRIVATE_DIRECTORY_MODE = 0o700;

/** The endpoint lock every ensure of `socket` serializes on, without its `.lock` suffix. */
export function hostEnsureLockTarget(socket: string): string {
	return join(hostLockDirectory(), createSocketLockName(socket));
}

/**
 * The directory every endpoint lock of THIS user lives in (senpi#6871). It was `<tmpdir>/senpi-rpc-host-locks`, which
 * on Linux is one `/tmp` directory for every user: the first user created it 0755 and every other user's host then
 * died on `EACCES` creating its lock. On POSIX it is `$XDG_RUNTIME_DIR/senpi-rpc-host-locks` when that runtime
 * directory is a private directory of this user, else `<tmpdir>/senpi-rpc-host-locks-<uid>`. win32 has no uid and its
 * temp directory is already the user's own, so it keeps the unsuffixed name there. Both inputs are environment the
 * daemon env allowlist passes on (`TMPDIR`, `XDG_*`), so a client and the host it started agree on the directory.
 */
function hostLockDirectory(): string {
	const uid = process.getuid?.();
	if (process.platform === "win32" || uid === undefined) return join(tmpdir(), LOCK_DIRECTORY_NAME);
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (runtime !== undefined && isPrivateRuntimeDirectory(runtime, uid)) return join(runtime, LOCK_DIRECTORY_NAME);
	return join(tmpdir(), `${LOCK_DIRECTORY_NAME}-${uid}`);
}

/** Usable as the XDG spec defines it: an absolute path to a directory this user owns, with no group or other access. */
function isPrivateRuntimeDirectory(path: string, uid: number): boolean {
	if (!isAbsolute(path)) return false;
	try {
		const entry = statSync(path);
		return entry.isDirectory() && entry.uid === uid && (entry.mode & 0o077) === 0;
	} catch {
		// Missing or unreadable: not usable, so the per-uid temp directory is used instead.
		return false;
	}
}

/**
 * Creates this user's lock directory, or proves an existing one is it. The name is predictable under a shared temp
 * root, so the directory is opened without following a symlink and checked through that handle: a symlink or another
 * user's directory at the name is refused and never written through, and one this user owns but left reachable by
 * group or others is tightened to 0700 through the same handle.
 */
export async function makeHostLockDirectory(directory: string): Promise<void> {
	await mkdir(dirname(directory), { recursive: true });
	await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE }).catch((cause: unknown) => {
		if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
	});
	if (process.platform === "win32") return;
	const unsafe = (reason: string, cause?: unknown) =>
		new Error(`rpc_host_lock_dir_unsafe: ${directory} is not a private directory of this user (${reason})`, {
			cause,
		});
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(
		(cause: unknown) => {
			throw unsafe("a symlink, or not openable by this user", cause);
		},
	);
	try {
		const entry = await handle.stat();
		if (entry.uid !== process.getuid?.()) throw unsafe(`owned by uid ${entry.uid}`);
		if ((entry.mode & 0o077) !== 0) await handle.chmod(PRIVATE_DIRECTORY_MODE);
	} finally {
		await handle.close();
	}
}

/** This user's lock directory made or proven, and the endpoint's lock target in it created; returns the target. */
export async function prepareHostEnsureLock(socket: string): Promise<string> {
	const lockTarget = hostEnsureLockTarget(socket);
	await makeHostLockDirectory(dirname(lockTarget));
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
