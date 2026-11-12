import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootModeIsGuarded } from "../modes/rpc/host-socket-bind.ts";
import { MAX_SOCKET_PATH_BYTES } from "../modes/rpc/socket-ownership.ts";
import {
	ProcessIdentityUnreadableError,
	processMatchesPidFile,
	readProcessIdentity,
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
const ENDPOINT_OWNER = ".owner";
/** A directory with no readable owner record is removed only once no server could still be writing one. */
const ENDPOINT_MIN_AGE_MS = 300_000;

/** The server's own endpoint, which the coordinator connects every client to; `release` removes a fallback directory. */
export interface ServerEndpoint {
	readonly path: string;
	release(): Promise<void>;
}

/** The roots a fallback endpoint may live in, in preference order (also what the reaper scans). */
export function serverEndpointRoots(): readonly string[] {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	// The per-user runtime directory first, then this user's temp directory, then the shared /tmp: each is tried only
	// when it is guarded, so an unguarded TMPDIR falls through to one that is.
	return [...new Set([...(runtimeDir === undefined ? [] : [runtimeDir]), tmpdir(), "/tmp"])];
}

/**
 * A root no other user can take an entry of ours out of, by the same rule the RPC host's bind alias applies: owned by
 * this user or root, and either sticky or writable by its owner alone. Anything else could let another user rename our
 * endpoint away and re-create its name while libuv still holds the path.
 */
async function guardedRoot(root: string): Promise<boolean> {
	const entry = await stat(root).catch(() => undefined);
	return entry !== undefined && entry.isDirectory() && rootModeIsGuarded(entry, process.getuid?.());
}

/**
 * The server endpoint lives next to the public socket when that path fits. In a deeper server directory it moves to a
 * fresh 0700 directory of this user's under the first guarded short root (as the RPC host's internal socket does,
 * senpi#3487): the server could bind the long path through its short bind-and-link, but nothing could connect to it,
 * so the coordinator dropped every client and the server retired without one (senpi#6522).
 */
export async function createServerEndpoint(preferredPath: string): Promise<ServerEndpoint> {
	if (socketPathFits(preferredPath)) return { path: preferredPath, release: async () => {} };
	const name = `${SHORT_SERVER_ENDPOINT_PREFIX}${randomUUID().slice(0, 8)}`;
	const roots = serverEndpointRoots();
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
	// Non-recursive and 0700: a fresh, unguessable directory of this user's, never an existing one. The owner record is
	// written before the directory is used, and the directory is removed if that fails, so the reaper can always prove
	// whether a server still owns it.
	await mkdir(directory, { recursive: false, mode: 0o700 });
	const release = (): Promise<void> => rm(directory, { recursive: true, force: true });
	try {
		const processStartTime = await readEndpointOwnerStartTime(process.pid);
		await writeFile(
			join(directory, ENDPOINT_OWNER),
			JSON.stringify({ pid: process.pid, processStartTime, createdAt: Date.now() }),
			{ mode: 0o600 },
		);
	} catch (error) {
		await release();
		throw error;
	}
	return { path: join(directory, "server.sock"), release };
}

/**
 * The one start-time reader both the owner record and the reaper use: in UTC, so a server and a later sweep running
 * under different TZ values read the same instant. The identity comes from the OS (`ps -o lstart` / `CreationDate`),
 * so a reused pid never matches the record it replaced.
 */
async function readEndpointOwnerStartTime(pid: number): Promise<string | undefined> {
	const identity = await readProcessIdentity(pid, process.platform, undefined, undefined, "UTC");
	if (identity.kind === "error") throw identity.error;
	return identity.kind === "present" ? identity.identity : undefined;
}

/**
 * Removes `senpi-xs-*` endpoint directories under `roots` that belong to this user and whose server is gone, as a
 * killed server leaves them behind: its owner record names a process that is provably not running, or the directory
 * has carried no readable record for ENDPOINT_MIN_AGE_MS. A record whose owner's identity cannot be read now is kept.
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
							const stats = await lstat(directory);
							if (uid !== undefined && stats.uid !== uid) return;
							if (await serverIsGone(directory, stats.mtimeMs))
								await rm(directory, { recursive: true, force: true });
						} catch {}
					}),
			);
		}),
	);
}

async function serverIsGone(directory: string, mtimeMs: number): Promise<boolean> {
	const raw = await readFile(join(directory, ENDPOINT_OWNER), "utf8").catch(() => undefined);
	const owner: unknown = raw === undefined ? undefined : JSON.parse(raw);
	const pid = typeof owner === "object" && owner !== null ? Reflect.get(owner, "pid") : undefined;
	const processStartTime =
		typeof owner === "object" && owner !== null ? Reflect.get(owner, "processStartTime") : undefined;
	if (typeof pid !== "number" || typeof processStartTime !== "string" || processStartTime.length === 0) {
		return mtimeMs <= Date.now() - ENDPOINT_MIN_AGE_MS;
	}
	const alive = await processMatchesPidFile({ pid, processStartTime }, readEndpointOwnerStartTime).catch(
		(error: unknown) => {
			if (error instanceof ProcessIdentityUnreadableError) return true;
			throw error;
		},
	);
	return !alive;
}
