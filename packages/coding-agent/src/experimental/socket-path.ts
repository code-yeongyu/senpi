import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../modes/rpc/socket-ownership.ts";

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
	const root = [tmpdir(), "/tmp"].find((candidate) => socketPathFits(join(candidate, name, "server.sock")));
	if (root === undefined) throw new SocketPathTooLongError("server", preferredPath);
	const directory = join(root, name);
	// Non-recursive and 0700: a fresh, unguessable directory of this user's, never an existing one.
	await mkdir(directory, { recursive: false, mode: 0o700 });
	return {
		path: join(directory, "server.sock"),
		release: () => rm(directory, { recursive: true, force: true }),
	};
}
