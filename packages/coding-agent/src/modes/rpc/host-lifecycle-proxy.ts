/**
 * The supervisor's PUBLIC socket: the byte proxy every client reaches the host through, the bind and
 * adoption of the public name, and the readiness probes of the private hop. Split out of
 * `host-lifecycle.ts`, which keeps the supervisor's orchestration (senpi#2566).
 */
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import type { HostAdmission } from "./host-admission.ts";
import { proxyWithAdmission } from "./host-admission-proxy.ts";
import type { ClientOccupancy } from "./host-client-occupancy.ts";
import { listen as bindOwnedSocket } from "./host-socket-bind.ts";
import { SpareHop } from "./host-spare-hop.ts";
import { connectInternalConnection } from "./internal-channel.ts";
import { PublicRpcConnection } from "./rpc-public-auth.ts";
import type { RpcPublicEndpoint } from "./rpc-public-key.ts";
import {
	type ListenerState,
	MAX_SOCKET_PATH_BYTES,
	type SocketFileIdentity,
	socketEntryListenerState,
} from "./socket-ownership.ts";

import {
	authenticateSocket,
	CHALLENGE_BUDGET_MS,
	ensureSocketSecret,
	resolveSocketTransportAddress,
	type Schedule,
	sendSocketHandshake,
	socketSecretPath,
	timerSchedule,
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
	/** Keep one authenticated engine hop ready for the next public client (`host-spare-hop.ts`, senpi#7055). */
	readonly spareHop?: boolean;
	/** The spare's refill and the challenge budget; tests fire them by hand. */
	readonly timers?: Schedule;
}

export function createPublicProxy(options: PublicProxyOptions): Server {
	const { internalSocket, internalSecret, internalKey, publicSecret, clients } = options;
	const schedule = options.timers ?? timerSchedule;
	const connectHop = (): Socket => {
		const socket = createConnection(resolveSocketTransportAddress(internalSocket, process.platform, internalSecret));
		if (internalSecret) sendSocketHandshake(socket, internalSecret);
		return socket;
	};
	const spare =
		options.spareHop && internalKey
			? new SpareHop(() => connectInternalConnection(connectHop(), internalKey), schedule)
			: undefined;
	options.admission.onStop(async () => spare?.dispose());
	const server = createServer((client) => {
		const auth = options.publicEndpoint
			? new PublicRpcConnection(client, options.publicEndpoint, undefined, { ms: CHALLENGE_BUDGET_MS, schedule })
			: undefined;
		const accept = async (): Promise<void> => {
			// Teardown is terminal even for an accept that raced socket shielding/server.close.
			if (!clients.admit(client)) return;
			client.pause();
			let internal: Duplex | undefined;
			const ownHop = (): Promise<Duplex> => {
				const socket = connectHop();
				internal = socket;
				return internalKey ? connectInternalConnection(socket, internalKey) : Promise.resolve(socket);
			};
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
				// Draining peers can still probe and receive typed open refusals, without a child hop.
				internal = options.admission.stopping ? undefined : await spare?.take();
				const hop = internal ?? (options.admission.stopping ? undefined : await ownHop());
				if (client.destroyed) {
					hop?.destroy();
					return;
				}
				proxyWithAdmission(client, hop, options.admission, auth, publicSecret !== undefined);
				// An authenticated endpoint resumes the client itself once its key record is published.
				if (!auth) client.resume();
			} catch {
				detach();
			}
		};
		if (publicSecret) authenticateSocket(client, publicSecret, () => void accept());
		else void accept();
	});
	server.once("close", () => spare?.dispose());
	return server;
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

/** Test-only seams for `prepareSocketPath`'s stale-entry check. */
export interface PrepareSocketPathHooks {
	/** Runs after the entry was probed dead and before it is unlinked. */
	readonly afterStaleProbe?: () => Promise<void>;
	/** Replaces the listener probe, so a test can pin each verdict. */
	readonly listenerState?: (socketPath: string) => Promise<ListenerState>;
}

/**
 * One entry's identity including its change time: a rebind at the same inode still moves ctime. Read with `lstat`, so
 * a symlink is stamped as itself (never as a socket) and the path it names is never consulted (#5314).
 */
type EntryStamp = {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly ctimeNs: bigint;
	readonly socket: boolean;
};

async function stampOf(socketPath: string): Promise<EntryStamp | undefined> {
	try {
		const entry = await lstat(socketPath, { bigint: true });
		return { dev: entry.dev, ino: entry.ino, ctimeNs: entry.ctimeNs, socket: entry.isSocket() };
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		throw cause;
	}
}

const sameStamp = (a: EntryStamp, b: EntryStamp): boolean =>
	a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs;

/**
 * Frees `socketPath` for this process's bind, removing only a dead socket entry and refusing everything else
 * (#5314). No portable fd-based check exists for a socket entry: `open()` fails on one (ENXIO on Linux,
 * EOPNOTSUPP on macOS), `O_PATH` is Linux-only, and there is no unlink-by-fd. So every read is `lstat`, which
 * never follows a link, and `unlink(2)` removes the name, never a link's target. The entry is re-stamped before
 * the second reachability probe (which must not be steered through a swapped-in link) and again as the last step
 * before the unlink; reachability is re-checked after the decision because a socket bound earlier can start
 * listening without changing identity.
 */
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
	if (!probed.socket) {
		throw new Error(
			`${socketPath}: address already in use, occupied by a non-socket entry (a symlink or other file; nothing listens there).`,
		);
	}
	const probe = hooks.listenerState ?? socketEntryListenerState;
	const state = await probe(socketPath);
	if (state.verdict === "gone") return;
	if (state.verdict === "live") throw inUse(state.evidence);
	await hooks.afterStaleProbe?.();
	// Something may have replaced the entry since the probe; unlink only the entry probed dead.
	const unchanged = async (): Promise<boolean> => {
		const current = await stampOf(socketPath);
		if (current === undefined) return false;
		if (!sameStamp(probed, current)) throw inUse("the entry changed after it was probed");
		return true;
	};
	if (!(await unchanged())) return;
	const again = await probe(socketPath);
	if (again.verdict === "gone") return;
	if (again.verdict === "live") throw inUse(again.evidence);
	if (!(await unchanged())) return;
	try {
		await unlink(socketPath);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
		throw cause;
	}
}

/** The supervisor's public bind: the same never-through-a-link publish as the socket host's (#5319). */
export function listen(
	server: Server,
	socketPath: string,
	secret?: Uint8Array,
): Promise<SocketFileIdentity | undefined> {
	return bindOwnedSocket(server, socketPath, secret);
}

export function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}
