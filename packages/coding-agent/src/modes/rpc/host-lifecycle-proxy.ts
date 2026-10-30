/**
 * The supervisor's PUBLIC socket: the byte proxy every client reaches the host through, the bind and
 * adoption of the public name, and the readiness probes of the private hop. Split out of
 * `host-lifecycle.ts`, which keeps the supervisor's orchestration (senpi#2566).
 */
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { HostAdmission } from "./host-admission.ts";
import { proxyWithAdmission } from "./host-admission-proxy.ts";
import type { ClientOccupancy } from "./host-client-occupancy.ts";
import { connectInternalConnection } from "./internal-channel.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { PublicRpcConnection } from "./rpc-public-auth.ts";
import type { RpcPublicEndpoint } from "./rpc-public-key.ts";
import { type ListenerState, MAX_SOCKET_PATH_BYTES, socketEntryListenerState } from "./socket-ownership.ts";

export { adoptPublicSocket } from "./socket-ownership.ts";
import {
	authenticateSocket,
	ensureSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";

export interface PublicProxyOptions {
	readonly internalSocket: string;
	readonly internalSecret?: Buffer;
	readonly internalKey?: Buffer;
	readonly publicSecret?: Buffer;
	readonly publicEndpoint?: RpcPublicEndpoint;
	readonly clients: ClientOccupancy;
	/** Shared authority for stopping, protocol replies and new-session admission. */
	readonly admission: HostAdmission;
	/** A client went away: occupancy changed. */
	readonly onDetach: () => void;
	/** A dropped unclassified admission breaks quiescence; a proven observing read does not. */
	readonly onAdmit?: () => void;
}

export function createPublicProxy(options: PublicProxyOptions): Server {
	const { internalSocket, internalSecret, publicSecret, clients } = options;
	return createServer((client) => {
		const auth = options.publicEndpoint ? new PublicRpcConnection(client, options.publicEndpoint) : undefined;
		const accept = async (): Promise<void> => {
			// Teardown is terminal even for an accept that raced socket shielding/server.close.
			if (!clients.admit(client)) return;
			client.pause();
			// Draining peers can still probe and receive typed open refusals, without a child hop.
			const internal = options.admission.stopping
				? undefined
				: createConnection(resolveSocketTransportAddress(internalSocket, process.platform, internalSecret));
			if (internal && internalSecret) sendSocketHandshake(internal, internalSecret);
			// A readiness exchange can begin and end between ticks: the client is recorded the
			// moment its first request line arrives, before a later tick can reuse the preceding
			// idle window. An observing read (`status`) is never recorded (host-client-occupancy.ts).
			const detach = (): void => {
				// Classification resets activity for attachments. Defer the unknown-admission reset
				// until release so a status read never resets owner grace, even between ticks.
				if (clients.release(client)) options.onAdmit?.();
				options.onDetach();
				internal?.destroy();
				client.destroy();
			};
			client.once("close", detach);
			client.once("error", detach);
			try {
				const hop =
					internal && options.internalKey
						? await connectInternalConnection(internal, options.internalKey)
						: internal;
				if (client.destroyed) {
					hop?.destroy();
					return;
				}
				proxyWithAdmission(client, hop, options.admission, auth);
				// An authenticated endpoint resumes the client itself once its key record is published.
				if (!auth) client.resume();
			} catch {
				detach();
			}
		};
		if (publicSecret) authenticateSocket(client, publicSecret, () => void accept());
		else void accept();
	});
}

/**
 * Reuses an existing valid secret - including one ensureHost() just wrote - and
 * creates one (with its parent directories, mode 0600) when it is missing or
 * unusable. Reuse is required, not just an optimization: on win32 the pipe name
 * is derived from the socket path AND the secret, so rotating it here would
 * point this supervisor at a different endpoint than its caller published.
 * A failure names the bootstrap step and the path it could not provision.
 */
export async function ensurePublicSocketSecret(publicSocket: string): Promise<Buffer> {
	const secretPath = socketSecretPath(publicSocket);
	try {
		return await ensureSocketSecret(secretPath);
	} catch (cause) {
		throw new Error(`senpi rpc host supervisor: cannot provision public socket secret ${secretPath}`, { cause });
	}
}

/**
 * One sealed readiness probe: the internal handshake and the ready reply together, on one monotonic timer (senpi#3816
 * review). A child that accepts the hop and stays silent that long is not a working host, so readiness fails at once
 * instead of hanging the supervisor; a host that is not listening yet is retried until the overall deadline.
 */
export const INTERNAL_READINESS_PROBE_MS = 10_000;

export async function waitForListener(
	socketPath: string,
	timeoutMs: number,
	secret?: Uint8Array,
	internalKey?: Buffer,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() <= deadline) {
		const probeMs = Math.max(1, Math.min(INTERNAL_READINESS_PROBE_MS, deadline - performance.now()));
		const probe = await canConnect(socketPath, secret, internalKey, probeMs);
		if (probe === "ready") return;
		if (probe === "silent")
			throw new Error(
				`${socketPath}: host accepted the internal hop but did not answer within ${Math.round(probeMs)}ms`,
			);
		// A host that answered but could not prove the key will not start proving it: fail now, and say why.
		if (probe !== "refused") throw new Error(`${socketPath}: ${probe.unproven}`);
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error(`${socketPath}: host did not start listening within ${timeoutMs}ms`);
}

async function canConnect(
	socketPath: string,
	secret: Uint8Array | undefined,
	internalKey: Buffer | undefined,
	probeMs: number,
): Promise<"ready" | "refused" | "silent" | { readonly unproven: "host_identity_unproven" | "auth_failed" }> {
	if (internalKey) {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let accepted = false;
		let expired = false;
		socket.once("connect", () => {
			accepted = true;
		});
		// Destroying the socket ends the handshake or the ready wait, whichever is running, and drops the connection.
		const timer = setTimeout(() => {
			expired = true;
			socket.destroy();
		}, probeMs);
		timer.unref();
		const outcome = (ready: boolean) => (ready ? "ready" : accepted && expired ? "silent" : "refused");
		try {
			const stream = await connectInternalConnection(socket, internalKey);
			return outcome(
				await new Promise<boolean>((resolve) => {
					const settle = (ready: boolean) => {
						stream.destroy();
						resolve(ready);
					};
					stream.once("error", () => settle(false));
					stream.once("close", () => settle(false));
					attachJsonlLineReader(
						stream,
						(line) => {
							try {
								const response = JSON.parse(line);
								if (response.id === "internal-ready") settle(response.success === true);
							} catch {
								settle(false);
							}
						},
						{ maxLineLength: MAX_RPC_LINE_CHARACTERS },
					);
					stream.write('{"id":"internal-ready","type":"get_protocol_info","observe":true}\n');
				}),
			);
		} catch (cause) {
			socket.destroy();
			const reason = cause instanceof Error ? cause.message : "";
			if (reason === "host_identity_unproven" || reason === "auth_failed") return { unproven: reason };
			return outcome(false);
		} finally {
			clearTimeout(timer);
		}
	}
	return new Promise((resolve) => {
		const socket: Socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		if (secret) sendSocketHandshake(socket, secret);
		const settle = (connected: boolean): void => {
			socket.destroy();
			resolve(connected ? "ready" : "refused");
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
	});
}

/** Test-only seams for `prepareSocketPath`'s stale-entry check. */
export interface PrepareSocketPathHooks {
	/** Runs after the entry was probed dead and before it is unlinked. */
	readonly afterStaleProbe?: () => Promise<void>;
	/** Replaces the listener probe, so a test can pin each verdict. */
	readonly listenerState?: (socketPath: string) => Promise<ListenerState>;
}

/** One entry's identity including its change time: a rebind at the same inode still moves ctime. */
type EntryStamp = {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly ctimeNs: bigint;
	readonly socket: boolean;
};

async function stampOf(socketPath: string): Promise<EntryStamp | undefined> {
	try {
		const entry = await stat(socketPath, { bigint: true });
		return { dev: entry.dev, ino: entry.ino, ctimeNs: entry.ctimeNs, socket: entry.isSocket() };
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		throw cause;
	}
}

const sameStamp = (a: EntryStamp, b: EntryStamp): boolean =>
	a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs;

export async function prepareSocketPath(socketPath: string, hooks: PrepareSocketPathHooks = {}): Promise<void> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) return;
	// A path the kernel would truncate binds a DIFFERENT endpoint than the one every client was
	// told about, and the failure surfaces much later as "the host does not answer". Refuse here.
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
		throw new Error(
			`${socketPath}: socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit.`,
		);
	}
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	const probed = await stampOf(socketPath);
	if (probed === undefined) return;
	const inUse = (evidence: string) =>
		new Error(`${socketPath}: address already in use by a live server (${evidence}).`);
	// Linux refuses a connect to a regular file too; never remove what is not a socket.
	if (!probed.socket) throw inUse("the entry is not a socket");
	const state = await (hooks.listenerState ?? socketEntryListenerState)(socketPath);
	if (state.verdict === "gone") return;
	if (state.verdict === "live") throw inUse(state.evidence);
	await hooks.afterStaleProbe?.();
	// Something may have replaced the entry since the probe; unlink only the entry probed dead.
	const current = await stampOf(socketPath);
	if (current === undefined) return;
	if (!sameStamp(probed, current)) throw inUse("the entry changed after it was probed");
	try {
		await unlink(socketPath);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
		throw cause;
	}
}

export function listen(server: Server, socketPath: string, secret?: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(
			{
				path: resolveSocketTransportAddress(socketPath, process.platform, secret),
				readableAll: false,
				writableAll: false,
			},
			async () => {
				server.off("error", reject);
				try {
					if (process.platform !== "win32" && !socketPath.startsWith("\0")) await chmod(socketPath, 0o600);
					resolve();
				} catch (cause) {
					reject(cause);
				}
			},
		);
	});
}

export function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}
