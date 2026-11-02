/** Where a socket host listens and how it binds: the `--listen` address forms and the owned bind (moved out of multi-session-host.ts). */
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BIND_SCRATCH_INFIX,
	BIND_SCRATCH_SOCKET,
	MAX_SOCKET_PATH_BYTES,
	type SocketFileIdentity,
} from "./socket-ownership.ts";
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

const BIND_DIR_ATTEMPTS = 8;
const ALIAS_PREFIX = "senpi-bind-";
const ALIAS_LINK = "d";
const SHORT_TEMP_ROOT = "/tmp";

/**
 * `<socketPath>.bind-<hex>`: a fresh 0700 directory beside the endpoint, so on its filesystem (`link(2)` can publish
 * from it) and named after it (`host gc` reclaims one a crash left, see `host-gc.ts`).
 */
async function makeBindDir(socketPath: string): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		const candidate = `${socketPath}${BIND_SCRATCH_INFIX}${randomBytes(6).toString("hex")}`;
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
 * The address to bind so the socket lands at `<bindDir>/s`. That path itself whenever it fits sun_path; otherwise
 * (any endpoint near MAX_SOCKET_PATH_BYTES) a short alias: a fresh 0700 temp directory holding this process's own
 * link to `bindDir`. Only that intermediate component is a link, created by us in a directory no other user can
 * write; the final name, the one `bind(2)` creates, is resolved inside the private `bindDir`. The alias costs at
 * most `/tmp/senpi-bind-XXXXXX/d/s`, so every endpoint `prepareSocketPath` accepts can bind.
 */
async function bindAddress(bindDir: string): Promise<{ readonly address: string; readonly alias?: string }> {
	const direct = join(bindDir, BIND_SCRATCH_SOCKET);
	if (Buffer.byteLength(direct) <= MAX_SOCKET_PATH_BYTES) return { address: direct };
	const fits = (root: string): boolean =>
		Buffer.byteLength(join(root, `${ALIAS_PREFIX}XXXXXX`, ALIAS_LINK, BIND_SCRATCH_SOCKET)) <= MAX_SOCKET_PATH_BYTES;
	const alias = await mkdtemp(join(fits(tmpdir()) ? tmpdir() : SHORT_TEMP_ROOT, ALIAS_PREFIX));
	try {
		await symlink(bindDir, join(alias, ALIAS_LINK));
	} catch (cause) {
		await rm(alias, { recursive: true, force: true });
		throw cause;
	}
	return { address: join(alias, ALIAS_LINK, BIND_SCRATCH_SOCKET), alias };
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
	const bindDir = await makeBindDir(socketPath);
	const bound = join(bindDir, BIND_SCRATCH_SOCKET);
	let alias: string | undefined;
	try {
		const target = await bindAddress(bindDir);
		alias = target.alias;
		await bindAt(server, target.address);
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
		if (alias !== undefined) await rm(alias, { recursive: true, force: true });
	}
}
