/**
 * The supervisor's PUBLIC socket: the byte proxy every client reaches the host through, the bind and
 * adoption of the public name, and the readiness probes of the private hop. Split out of
 * `host-lifecycle.ts`, which keeps the supervisor's orchestration (senpi#2566).
 */
import { access, chmod, mkdir, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { ClientOccupancy } from "./host-client-occupancy.ts";
import { MAX_SOCKET_PATH_BYTES, type SocketFileIdentity, statSocketIdentity } from "./socket-ownership.ts";
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
	readonly publicSecret?: Buffer;
	readonly clients: ClientOccupancy;
	/** True while the supervisor accepts nothing new: shutting down or draining. */
	readonly refusing: () => boolean;
	/** A client went away: occupancy changed. */
	readonly onDetach: () => void;
}

export function createPublicProxy(options: PublicProxyOptions): Server {
	const { internalSocket, internalSecret, publicSecret, clients } = options;
	return createServer((client) => {
		const accept = (): void => {
			// A draining supervisor serves what it already proxies and accepts nothing new. After a
			// handoff the public path resolves to the successor anyway; this covers the connection
			// that raced the rename, and a drain-stop with no successor at all.
			if (options.refusing()) {
				client.destroy();
				return;
			}
			const internal = createConnection(
				resolveSocketTransportAddress(internalSocket, process.platform, internalSecret),
			);
			if (internalSecret) sendSocketHandshake(internal, internalSecret);
			// A readiness exchange can begin and end between ticks: the client is recorded the
			// moment its first request line arrives, before a later tick can reuse the preceding
			// idle window. An observing read (`status`) is never recorded (host-client-occupancy.ts).
			clients.admit(client);
			const detach = (): void => {
				clients.release(client);
				options.onDetach();
				internal.destroy();
				client.destroy();
			};
			client.pipe(internal);
			internal.pipe(client);
			client.once("close", detach);
			client.once("error", detach);
			// Let the final lifecycle records drain through the public socket before closing it.
			internal.once("end", () => client.end(() => client.destroy()));
			internal.once("close", () => {
				if (!internal.readableEnded) detach();
			});
			internal.once("error", detach);
		};
		if (publicSecret) authenticateSocket(client, publicSecret, accept);
		else accept();
	});
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

export async function waitForListener(socketPath: string, timeoutMs: number, secret?: Uint8Array): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (await canConnect(socketPath, secret)) return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error(`${socketPath}: host did not start listening within ${timeoutMs}ms`);
}

function canConnect(socketPath: string, secret?: Uint8Array): Promise<boolean> {
	return new Promise((resolve) => {
		const socket: Socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		if (secret) sendSocketHandshake(socket, secret);
		const settle = (value: boolean): void => {
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
	});
}

export async function prepareSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32") return;
	// A path the kernel would truncate binds a DIFFERENT endpoint than the one every client was
	// told about, and the failure surfaces much later as "the host does not answer". Refuse here.
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
		throw new Error(
			`${socketPath}: socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit.`,
		);
	}
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	try {
		await access(socketPath);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
		throw cause;
	}
	if (await canConnect(socketPath)) throw new Error(`${socketPath}: address already in use by a live server.`);
	await unlink(socketPath);
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
