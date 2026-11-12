import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAliasOwnerStartTime, rootModeIsGuarded } from "../modes/rpc/host-socket-bind.ts";
import { MAX_SOCKET_PATH_BYTES } from "../modes/rpc/socket-ownership.ts";
import { ProcessIdentityUnreadableError, processMatchesPidFile } from "../utils/process-identity.ts";

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

export interface ServerEndpointOptions {
	/** Temp roots to try, in order (default: the OS temp directory, then `/tmp`). */
	readonly roots?: readonly string[];
	/** Start-time reader for the owner record (default: the UTC reader the reaper also uses). */
	readonly readStartTime?: (pid: number) => Promise<string | undefined>;
}

/**
 * The server endpoint lives next to the public socket when that path fits. In a deeper server directory it moves to a
 * fresh 0700 directory of this user's under the OS temp directory (or `/tmp` when that is too deep, as the RPC host's
 * internal socket does, senpi#3487): the server could bind the long path through its short bind-and-link, but nothing
 * could connect to it, so the coordinator dropped every client and the server retired without one (senpi#6522).
 * A root another user could take an entry out of is skipped, as the RPC host's bind alias does.
 */
export async function createServerEndpoint(
	preferredPath: string,
	options: ServerEndpointOptions = {},
): Promise<ServerEndpoint> {
	if (socketPathFits(preferredPath)) return { path: preferredPath, release: async () => {} };
	const name = `${SHORT_SERVER_ENDPOINT_PREFIX}${randomUUID().slice(0, 8)}`;
	const roots = options.roots ?? defaultServerEndpointRoots();
	await reapOrphanedServerEndpoints(roots);
	let root: string | undefined;
	for (const candidate of roots) {
		if (socketPathFits(join(candidate, name, "server.sock")) && (await guardedRoot(candidate))) {
			root = candidate;
			break;
		}
	}
	if (root === undefined) throw new SocketPathTooLongError("server", preferredPath);
	const directory = join(root, name);
	// Non-recursive and 0700: a fresh, unguessable directory of this user's, never an existing one.
	await mkdir(directory, { recursive: false, mode: 0o700 });
	const release = () => rm(directory, { recursive: true, force: true });
	try {
		// An unreadable start time is recorded as null: the reaper then never proves this directory dead.
		const readStartTime = options.readStartTime ?? readAliasOwnerStartTime;
		const processStartTime = await readStartTime(process.pid).catch(() => undefined);
		await writeFile(
			join(directory, ".owner"),
			JSON.stringify({ pid: process.pid, processStartTime: processStartTime ?? null }),
			{ mode: 0o600 },
		);
	} catch (error) {
		await release();
		throw error;
	}
	return { path: join(directory, "server.sock"), release };
}

/** A root no other user can take an entry of ours out of, the check the RPC host's bind alias applies. */
async function guardedRoot(root: string): Promise<boolean> {
	const entry = await stat(root).catch(() => undefined);
	return entry !== undefined && entry.isDirectory() && rootModeIsGuarded(entry, process.getuid?.());
}

/**
 * Removes `senpi-xs-*` endpoint directories under `roots` that belong to this user and whose recorded server is
 * provably gone, as a killed server leaves them behind. The owner start time is written and read in UTC
 * (`readAliasOwnerStartTime`), so a server and a later sweep running under different TZ values read the same instant. A directory without a readable owner record, with an owner start
 * time that was never read, is kept for OWNERLESS_MIN_AGE_MS and removed after that; one whose owner's identity cannot be
 * read now is kept: it may belong to a live server.
 */
/**
 * The OS temp directory first, then the per-user runtime directory, then the shared `/tmp`; each is used only when it
 * is guarded, so an unguarded TMPDIR falls back to this user's runtime directory before the shared root.
 */
function defaultServerEndpointRoots(): readonly string[] {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	return [...new Set([tmpdir(), ...(runtimeDir === undefined || runtimeDir === "" ? [] : [runtimeDir]), "/tmp"])];
}

/** A directory with no usable owner record is removed only once no starting server could still be writing one. */
const OWNERLESS_MIN_AGE_MS = 300_000;

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
							const stats = await lstat(directory);
							if (uid !== undefined && stats.uid !== uid) return;
							const ownerless = stats.mtimeMs <= Date.now() - OWNERLESS_MIN_AGE_MS;
							const raw = await readFile(join(directory, ".owner"), "utf8").catch(() => undefined);
							const owner: unknown = raw === undefined ? undefined : JSON.parse(raw);
							const pid: unknown =
								typeof owner === "object" && owner !== null ? Reflect.get(owner, "pid") : undefined;
							const processStartTime: unknown =
								typeof owner === "object" && owner !== null
									? Reflect.get(owner, "processStartTime")
									: undefined;
							if (
								typeof pid !== "number" ||
								typeof processStartTime !== "string" ||
								processStartTime.length === 0
							) {
								if (ownerless) await rm(directory, { recursive: true, force: true });
								return;
							}
							const alive = await processMatchesPidFile(
								{ pid, processStartTime },
								readAliasOwnerStartTime,
							).catch((error: unknown) => {
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
