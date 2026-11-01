/** Where a socket host listens and how it binds: the `--listen` address forms and the owned bind (moved out of multi-session-host.ts). */
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { dirname, join } from "node:path";
import { MAX_SOCKET_PATH_BYTES, type SocketFileIdentity } from "./socket-ownership.ts";
import { resolveSocketTransportAddress } from "./socket-transport.ts";

export function resolveSocketPath(value: string, agentDir: string): string {
	if (value === "unix://") return join(agentDir, "rpc", "rpc.sock");
	if (value.startsWith("unix://")) {
		const path = value.slice("unix://".length);
		if (path.length === 0) return join(agentDir, "rpc", "rpc.sock");
		if (path.startsWith("@") && process.platform === "linux") return `\0${path.slice(1)}`;
		return path;
	}
	return value;
}

export function formatSocketAddress(socketPath: string): string {
	return socketPath.startsWith("\0") ? `unix://@${socketPath.slice(1)}` : `unix://${socketPath}`;
}

function bindAt(server: Server, address: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen({ path: address, readableAll: false, writableAll: false }, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

const BOUND_NAME = "s";
const BIND_DIR_ATTEMPTS = 8;

/**
 * A fresh 0700 directory beside the endpoint: the same filesystem, so `link(2)` can publish from it, and named
 * short enough that the bind path stays within MAX_SOCKET_PATH_BYTES whenever the endpoint does.
 */
async function makeBindDir(dir: string): Promise<string> {
	const room = MAX_SOCKET_PATH_BYTES - Buffer.byteLength(join(dir, ".", BOUND_NAME));
	if (room < 1)
		throw new Error(`${dir}: no room for a bind directory within the ${MAX_SOCKET_PATH_BYTES}-byte limit.`);
	for (let attempt = 1; ; attempt++) {
		const candidate = join(dir, `.${randomBytes(6).toString("hex").slice(0, Math.min(12, room))}`);
		try {
			await mkdir(candidate, { mode: 0o700 });
			return candidate;
		} catch (cause) {
			const taken = cause instanceof Error && "code" in cause && cause.code === "EEXIST";
			if (!taken || attempt === BIND_DIR_ATTEMPTS) throw cause;
		}
	}
}

/**
 * Binds and publishes the socket at `socketPath` without ever resolving a link there (#5319). macOS `bind(2)`
 * follows a dangling symlink and creates the socket at its target, so the socket is bound inside a fresh private
 * directory and published with `link(2)`: atomic, never follows the new name, and fails EEXIST on ANY entry that
 * took the endpoint after `prepareSocketPath` (a planted link, or a live socket). `rename(2)` would silently
 * replace that entry instead. Returns the identity of the published entry; shutdown removes the path only while
 * that identity still matches. Windows pipes and Linux abstract sockets have no filesystem entry and bind directly.
 */
export async function listen(
	server: Server,
	socketPath: string,
	secret?: Uint8Array,
): Promise<SocketFileIdentity | undefined> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) {
		await bindAt(server, resolveSocketTransportAddress(socketPath, process.platform, secret));
		return undefined;
	}
	const bindDir = await makeBindDir(dirname(socketPath));
	const bound = join(bindDir, BOUND_NAME);
	try {
		await bindAt(server, bound);
		await chmod(bound, 0o600);
		const entry = await lstat(bound);
		await link(bound, socketPath);
		return { dev: entry.dev, ino: entry.ino };
	} catch (cause) {
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
			throw new Error(
				`${socketPath}: address already in use (an entry took the endpoint before the bind was published).`,
			);
		}
		throw cause;
	} finally {
		await rm(bindDir, { recursive: true, force: true });
	}
}
