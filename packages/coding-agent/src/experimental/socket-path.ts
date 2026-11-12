import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../modes/rpc/socket-ownership.ts";
import {
	ProcessIdentityUnreadableError,
	processMatchesPidFile,
	readProcessStartTime,
} from "../utils/process-identity.ts";

/** A Unix socket path the platform cannot connect to: sun_path holds 104 bytes on macOS and 108 on Linux. */
export class SocketPathTooLongError extends Error {
	readonly code = "socket_path_too_long";
	readonly path: string;
	readonly bytes: number;
	readonly limit = MAX_SOCKET_PATH_BYTES;

	constructor(role: string, path: string) {
		const bytes = Buffer.byteLength(path);
		super(
			`The experimental server's ${role} socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte Unix socket limit: ${path}. Use a shorter server directory (PI_SERVER_DIR).`,
		);
		this.name = "SocketPathTooLongError";
		this.path = path;
		this.bytes = bytes;
	}
}

export function socketPathFits(path: string): boolean {
	return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES;
}

export function assertSocketPathFits(role: string, path: string): void {
	if (!socketPathFits(path)) throw new SocketPathTooLongError(role, path);
}

export const SHORT_SERVER_ENDPOINT_PREFIX = "senpi-xs-";

/** The server's own endpoint, which the coordinator connects every client to; `release` removes a fallback directory. */
export interface ServerEndpoint {
	readonly path: string;
	release(): Promise<void>;
}

/**
 * The server endpoint lives next to the public socket when that path fits. In a deeper server directory it moves to a
 * fresh 0700 directory of this user's under the OS temp directory (or `/tmp` when that is too deep, as the RPC host's
 * internal socket does, senpi#3487): the server could bind the long path through its short bind-and-link, but nothing
 * could connect to it, so the coordinator dropped every client and the server retired without one (senpi#6522).
 */
export async function createServerEndpoint(preferredPath: string): Promise<ServerEndpoint> {
	if (socketPathFits(preferredPath)) return { path: preferredPath, release: async () => {} };
	const name = `${SHORT_SERVER_ENDPOINT_PREFIX}${randomUUID().slice(0, 8)}`;
	const roots = [tmpdir(), "/tmp"];
	await reapOrphanedServerEndpoints(roots);
	const root = roots.find((candidate) => socketPathFits(join(candidate, name, "server.sock")));
	if (root === undefined) throw new SocketPathTooLongError("server", preferredPath);
	const directory = join(root, name);
	// Non-recursive and 0700: a fresh, unguessable directory of this user's, never an existing one.
	await mkdir(directory, { recursive: false, mode: 0o700 });
	const processStartTime = await readProcessStartTime(process.pid);
	await writeFile(
		join(directory, ".owner"),
		JSON.stringify({ pid: process.pid, processStartTime: processStartTime ?? null }),
		{
			mode: 0o600,
		},
	);
	return {
		path: join(directory, "server.sock"),
		release: () => rm(directory, { recursive: true, force: true }),
	};
}

/**
 * Removes `senpi-xs-*` endpoint directories under `roots` that belong to this user and whose recorded server is
 * provably gone, as a killed server leaves them behind. A directory without a readable owner record, with an owner start
 * time that was never read, or whose owner's identity cannot be read now, is kept: it may belong to a live server.
 */
export async function reapOrphanedServerEndpoints(roots: readonly string[]): Promise<void> {
	const uid = process.getuid?.();
	await Promise.all(
		[...new Set(roots)].map(async (root) => {
			const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
			await Promise.all(
				entries
					.filter((entry) => entry.isDirectory() && entry.name.startsWith(SHORT_SERVER_ENDPOINT_PREFIX))
					.map(async (entry) => {
						const directory = join(root, entry.name);
						try {
							if (uid !== undefined && (await lstat(directory)).uid !== uid) return;
							const owner: unknown = JSON.parse(await readFile(join(directory, ".owner"), "utf8"));
							if (typeof owner !== "object" || owner === null) return;
							const pid: unknown = Reflect.get(owner, "pid");
							const processStartTime: unknown = Reflect.get(owner, "processStartTime");
							if (
								typeof pid !== "number" ||
								typeof processStartTime !== "string" ||
								processStartTime.length === 0
							)
								return;
							const alive = await processMatchesPidFile({ pid, processStartTime }).catch((error: unknown) => {
								if (error instanceof ProcessIdentityUnreadableError) return true;
								throw error;
							});
							if (!alive) await rm(directory, { recursive: true, force: true });
						} catch {}
					}),
			);
		}),
	);
}
