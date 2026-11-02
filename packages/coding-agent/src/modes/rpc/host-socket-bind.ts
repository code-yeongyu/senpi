/** Where a socket host listens and how it binds: the `--listen` address forms and the owned bind (moved out of multi-session-host.ts). */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, stat, symlink } from "node:fs/promises";
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
 * A root no other user can take an entry of ours out of: sticky (`/tmp`), or writable by its owner alone where that
 * owner is this user or root (the per-user macOS temp directory). Anything else could let another user rename the
 * alias away and re-create its name while libuv still holds the path.
 */
async function guardedRoot(root: string): Promise<boolean> {
	const entry = await stat(root).catch(() => undefined);
	if (entry === undefined || !entry.isDirectory()) return false;
	if ((entry.mode & 0o1000) !== 0) return true;
	return (entry.mode & 0o022) === 0 && (entry.uid === 0 || entry.uid === process.getuid?.());
}

async function aliasRoot(): Promise<string> {
	const tried: string[] = [];
	for (const root of [tmpdir(), SHORT_TEMP_ROOT]) {
		const longest = join(root, `${ALIAS_PREFIX}XXXXXX`, ALIAS_LINK, BIND_SCRATCH_SOCKET);
		if (Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES && (await guardedRoot(root))) return root;
		tried.push(root);
	}
	throw new Error(
		`bind_alias_unavailable: no short temp root is sticky or private to this user (${tried.join(", ")}); set TMPDIR to one`,
	);
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
	const alias = await mkdtemp(join(await aliasRoot(), ALIAS_PREFIX));
	try {
		await symlink(bindDir, join(alias, ALIAS_LINK));
	} catch (cause) {
		removeScratch([alias]);
		throw cause;
	}
	return { address: join(alias, ALIAS_LINK, BIND_SCRATCH_SOCKET), alias };
}

/** Removes every scratch path, each on its own, then throws the first failure. */
function removeScratch(paths: readonly string[]): void {
	const failures: unknown[] = [];
	for (const path of paths) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch (cause) {
			failures.push(cause);
		}
	}
	if (failures.length > 0) throw failures[0];
}

/**
 * libuv unlinks the path a pipe was BOUND to when its listening handle closes, so every directory on that path stays
 * ours until then: removed on the server's `close` event (emitted after the handle closed), or at process exit,
 * when no unlink can follow any more. Removed earlier, another user could re-create a name on the path pointing at
 * a directory of their choice and have this host delete `s` there on close. Synchronous, so a close callback
 * already sees the scratch gone.
 */
function removeScratchAfterClose(server: Server, paths: readonly string[]): void {
	const sweep = (): void => {
		try {
			removeScratch(paths);
		} catch (cause) {
			process.emitWarning(`bind scratch ${paths.join(", ")} was not removed: ${String(cause)}`);
		}
	};
	const onClose = (): void => {
		process.off("exit", onExit);
		sweep();
	};
	const onExit = (): void => {
		server.off("close", onClose);
		sweep();
	};
	server.once("close", onClose);
	process.once("exit", onExit);
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
	const scratch = [bindDir];
	const bound = join(bindDir, BIND_SCRATCH_SOCKET);
	try {
		const target = await bindAddress(bindDir);
		if (target.alias !== undefined) scratch.push(target.alias);
		await bindAt(server, target.address);
		await chmod(bound, 0o600);
		const entry = await lstat(bound);
		await link(bound, socketPath);
		removeScratchAfterClose(server, scratch);
		return { dev: entry.dev, ino: entry.ino };
	} catch (cause) {
		// Closed first: its unlink still lands inside our own directories.
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		const failure =
			cause instanceof Error && "code" in cause && cause.code === "EEXIST"
				? new Error(
						`${socketPath}: address already in use (an entry took the endpoint before the bind was published).`,
					)
				: cause;
		try {
			removeScratch(scratch);
		} catch (cleanup) {
			throw new AggregateError([failure, cleanup], `${String(failure)}; the bind scratch was not removed either`);
		}
		throw failure;
	}
}
