/**
 * Ownership-checked removal for Unix domain socket path entries.
 *
 * A socket path is a rendezvous name, not a capability: once a host unlinks
 * its entry, any other process may bind the same path. Teardown that removes
 * "its" socket by path alone can therefore delete a NEWER host's freshly
 * published entry after a takeover renamed a replacement over that path. The
 * startup path already refuses to touch a socket owned by a live server
 * (`prepareSocketPath`); these helpers give every teardown path the same rule:
 * capture the bound entry's filesystem identity (dev + ino) at listen time and
 * unlink only while the path still stat-matches that identity.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Filesystem identity of one bound socket path entry. */
export interface SocketFileIdentity {
	readonly dev: number;
	readonly ino: number;
}

/**
 * Name of the sidecar, inside the lifecycle supervisor's private scratch
 * directory, that records which public socket entry that supervisor bound. The
 * directory is per-supervisor, so a replacement supervisor's token can never be
 * mistaken for the old one's.
 */
export const PUBLIC_SOCKET_IDENTITY_FILE = "public-socket.owner";

/** Default bound on waiting for a supervisor to publish its ownership token. */
export const SOCKET_IDENTITY_WAIT_MS = 30_000;

function sameSocketIdentity(a: SocketFileIdentity, b: SocketFileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Reads the current identity of a socket path entry; `undefined` once absent. */
export async function statSocketIdentity(socketPath: string): Promise<SocketFileIdentity | undefined> {
	try {
		const { dev, ino } = await stat(socketPath);
		return { dev, ino };
	} catch (cause) {
		if (isNodeErrorCode(cause, "ENOENT")) return undefined;
		throw cause;
	}
}

/** Records a bound socket identity for teardown paths that cannot hold it in memory. */
export async function writeSocketIdentityFile(path: string, identity: SocketFileIdentity): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmpPath = `${path}.${process.pid}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
	await rename(tmpPath, path);
}

export async function readSocketIdentityFile(path: string): Promise<SocketFileIdentity | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (cause) {
		if (isNodeErrorCode(cause, "ENOENT")) return undefined;
		throw cause;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Truncated or in-progress JSON is not a token: callers wait or leave the path.
		return undefined;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as { dev?: unknown }).dev !== "number" ||
		typeof (parsed as { ino?: unknown }).ino !== "number"
	) {
		return undefined;
	}
	return { dev: (parsed as { dev: number }).dev, ino: (parsed as { ino: number }).ino };
}

/**
 * Waits, bounded, for an identity file to appear. The lifecycle supervisor
 * publishes its public-socket token after this host's internal listener is
 * ready, so supervised hosts poll briefly instead of assuming ordering.
 */
export async function waitForSocketIdentityFile(
	path: string,
	timeoutMs: number = SOCKET_IDENTITY_WAIT_MS,
	intervalMs = 25,
): Promise<SocketFileIdentity | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const identity = await readSocketIdentityFile(path);
		if (identity !== undefined) return identity;
		if (Date.now() >= deadline) return undefined;
		await delayUnrefed(intervalMs);
	}
}

/**
 * Unlinks a socket path only while it still refers to the entry `identity`
 * describes. An absent path is nothing to do; a mismatched identity means a
 * newer host owns the name now and is left alone; an unknown identity can
 * never be proven ours, so the path is left and the decision is logged.
 */
export async function unlinkOwnedSocket(
	socketPath: string,
	identity: SocketFileIdentity | undefined,
	log: (message: string) => void,
): Promise<void> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) return;
	let current: SocketFileIdentity | undefined;
	try {
		current = await statSocketIdentity(socketPath);
	} catch (cause) {
		log(`socket ${socketPath} ownership could not be verified (${errorMessage(cause)}); leaving it`);
		return;
	}
	if (current === undefined) return;
	if (identity === undefined) {
		log(`socket path ${socketPath} ownership unknown; leaving it`);
		return;
	}
	if (!sameSocketIdentity(current, identity)) {
		log(`socket path ${socketPath} now owned by another host; leaving it`);
		return;
	}
	try {
		await unlink(socketPath);
	} catch (cause) {
		if (!isNodeErrorCode(cause, "ENOENT")) {
			log(`socket ${socketPath} removal failed (${errorMessage(cause)})`);
		}
	}
}

/**
 * Runs `close` with the socket path's current entry shielded from libuv's
 * close-time unlink.
 *
 * libuv unlinks the NAME a pipe was bound to when its listening handle
 * closes - even when a takeover has renamed a DIFFERENT socket over that
 * name, so an ordinary `server.close()` silently deletes the newer host's
 * freshly published entry. Moving the current entry aside for the duration
 * of the close (libuv's unlink then hits ENOENT) and restoring it afterwards
 * keeps the filesystem exactly as it was; ownership-checked removal via
 * `unlinkOwnedSocket` decides afterwards what may actually be deleted.
 */
export async function shieldSocketDuringClose(socketPath: string, close: () => Promise<void>): Promise<void> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) return close();
	const shieldPath = `${socketPath}.shield-${process.pid}`;
	let shielded = false;
	try {
		if ((await statSocketIdentity(socketPath)) !== undefined) {
			await rename(socketPath, shieldPath);
			shielded = true;
		}
	} catch {
		// Without a shield the close degrades to today's behavior; the
		// ownership-checked unlink still runs afterwards.
	}
	try {
		await close();
	} finally {
		if (shielded) {
			try {
				await rename(shieldPath, socketPath);
			} catch {
				// Best effort: a failed restore leaves the entry under the shield
				// name; startup probes treat a dead entry as replaceable.
			}
		}
	}
}

function delayUnrefed(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}
