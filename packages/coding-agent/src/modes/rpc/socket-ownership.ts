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
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { resolveSocketTransportAddress } from "./socket-transport.ts";

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

/** What the public path holds relative to the entry a generation bound there. */
export type EndpointOwnership = "held" | "replaced" | "absent" | "unknown";

/** Default bound on waiting for a supervisor to publish its ownership token. */
export const SOCKET_IDENTITY_WAIT_MS = 30_000;

/**
 * `sun_path` is 104 bytes INCLUDING its terminator on macOS, so a bindable path fits in 103.
 * A generation's bind path is the longest name this daemon ever produces, which makes it the
 * one that must be checked before a bind turns the overflow into a truncated, silently wrong
 * endpoint.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * Where a successor generation binds before it owns the public name. It never binds the live
 * public path: that path belongs to the running host until the successor is proven to work.
 */
export function generationBindPath(publicSocket: string, generation: number): string {
	return `${publicSocket}.next-${generation}`;
}

function sameSocketIdentity(a: SocketFileIdentity, b: SocketFileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/**
 * What one failed connect says about the process behind a socket entry. Only a refusal can mean
 * "nobody": on Linux a full backlog answers EAGAIN, so ECONNREFUSED is proof of absence there,
 * but macOS (and the BSDs) refuse a live listener whose backlog is full, so a refusal there needs
 * a second witness. ENOENT means the entry is gone; every other error is a live owner (I1).
 */
export type ConnectVerdict = "live" | "dead" | "gone" | "confirm-holder";

export function classifyConnectError(code: string | undefined, platform: NodeJS.Platform): ConnectVerdict {
	if (code === "ENOENT") return "gone";
	if (code === "ECONNREFUSED") return platform === "linux" ? "dead" : "confirm-holder";
	return "live";
}

/** Whether any process holds the entry open: pids from `lsof -t`, none, or unknown. */
export type SocketHolders = (socketPath: string) => Promise<readonly number[] | undefined>;

const HOLDER_PROBE_TIMEOUT_MS = 5_000;

export const lsofSocketHolders: SocketHolders = (socketPath) =>
	new Promise((resolve) => {
		execFile("lsof", ["-t", "--", socketPath], { timeout: HOLDER_PROBE_TIMEOUT_MS }, (error, stdout) => {
			const pids = String(stdout)
				.split(/\s+/)
				.filter((part) => /^\d+$/.test(part))
				.map(Number);
			if (pids.length > 0) return resolve(pids);
			// lsof exits 1 with no output when nothing holds the file; anything else proves nothing.
			const exitCode: unknown = error === null ? undefined : Reflect.get(error, "code");
			resolve(error === null || exitCode === 1 ? [] : undefined);
		});
	});

const CONNECT_PROBE_TIMEOUT_MS = 2_000;

/** One connect to the entry: `connected`, or the error code it failed with (`timeout` when it hung). */
function connectOnce(
	socketPath: string,
): Promise<{ readonly connected: true } | { readonly code: string | undefined }> {
	return new Promise((resolve) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform));
		const settle = (value: { readonly connected: true } | { readonly code: string | undefined }): void => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(CONNECT_PROBE_TIMEOUT_MS, () => settle({ code: "timeout" }));
		socket.once("connect", () => settle({ connected: true }));
		socket.once("error", (cause: NodeJS.ErrnoException) => settle({ code: cause.code }));
	});
}

/** Whether a live process stands behind a socket entry, and the evidence for the answer. */
export interface ListenerState {
	readonly verdict: "live" | "dead" | "gone";
	readonly evidence: string;
}

export async function socketEntryListenerState(
	socketPath: string,
	platform: NodeJS.Platform = process.platform,
	holders: SocketHolders = lsofSocketHolders,
): Promise<ListenerState> {
	const attempt = await connectOnce(socketPath);
	if ("connected" in attempt) return { verdict: "live", evidence: "accepting connections" };
	const verdict = classifyConnectError(attempt.code, platform);
	if (verdict !== "confirm-holder") return { verdict, evidence: `connect ${attempt.code ?? "failed"}` };
	const pids = await holders(socketPath);
	if (pids === undefined) return { verdict: "live", evidence: "connect ECONNREFUSED, holders unknown" };
	if (pids.length > 0)
		return { verdict: "live", evidence: `connect ECONNREFUSED, held open by pid ${pids.join(",")}` };
	return { verdict: "dead", evidence: "connect ECONNREFUSED, held by nobody" };
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

/**
 * What the public path now holds relative to the entry `identity` describes, in ONE stat so the
 * answers cannot disagree with each other:
 *
 * - `held`: still this generation's own entry.
 * - `replaced`: a successor renamed its socket over it, or something else took the name.
 * - `absent`: no entry at all - somebody's `rm`, a swept temp directory, a deleted workspace.
 * - `unknown`: nothing can be proven (no identity, win32, an abstract socket, a failed stat).
 *
 * `replaced` and `absent` are both losses of reachability, but they are NOT the same observation
 * and callers must keep them apart: a successor is serving clients on that name, while an absent
 * name serves nobody. `unknown` is never a claim.
 */
export async function classifyEndpointOwnership(
	socketPath: string,
	identity: SocketFileIdentity | undefined,
): Promise<EndpointOwnership> {
	if (identity === undefined || process.platform === "win32" || socketPath.startsWith("\0")) return "unknown";
	let current: SocketFileIdentity | undefined;
	try {
		current = await statSocketIdentity(socketPath);
	} catch {
		return "unknown";
	}
	if (current === undefined) return "absent";
	return sameSocketIdentity(current, identity) ? "held" : "replaced";
}

/**
 * Whether `socketPath` is served by a DIFFERENT entry than `identity` describes: a successor
 * generation renamed its own socket over it, or something else took the name. A generation that
 * finds this true no longer owns the endpoint and cannot be reached by path any more.
 *
 * An absent entry and an unknown identity both answer `false`. Supersession has to be POSITIVELY
 * observed - a name that is merely missing is somebody's `rm`, not a newer host, and treating it as
 * one would make a healthy daemon drain itself.
 */
export async function socketEntryReplaced(
	socketPath: string,
	identity: SocketFileIdentity | undefined,
): Promise<boolean> {
	return (await classifyEndpointOwnership(socketPath, identity)) === "replaced";
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

/**
 * Takes the public name over with a rename, once - and only while - that name still refers to the
 * entry this handoff was decided against. A socket that changed underneath belongs to another
 * process now: replacing it would unlink an endpoint this generation cannot prove it owns, so the
 * successor aborts instead and leaves both the intruder's socket and its own bind entry alone.
 */
export async function adoptPublicSocket(
	bindSocket: string,
	publicSocket: string,
	expected: SocketFileIdentity | undefined,
): Promise<void> {
	if (expected === undefined) throw new Error(`${publicSocket}: a generation launch must name the entry it replaces`);
	const current = await statSocketIdentity(publicSocket);
	if (current === undefined || current.dev !== expected.dev || current.ino !== expected.ino) {
		throw new Error(`${publicSocket}: owned by another socket entry now; refusing to replace it`);
	}
	// rename(2) is atomic for readers of the path: every connect either reaches the old entry or
	// this one, never nothing. The inode this supervisor bound simply answers to a second name.
	await rename(bindSocket, publicSocket);
}
