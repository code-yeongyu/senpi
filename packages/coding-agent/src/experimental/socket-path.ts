import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootModeIsGuarded } from "../modes/rpc/host-socket-bind.ts";
import { MAX_SOCKET_PATH_BYTES } from "../modes/rpc/socket-ownership.ts";
import {
	ProcessIdentityUnreadableError,
	processIsLive,
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

/** The server's own endpoint, which the coordinator connects every client to; `release` removes a fallback directory. */
export interface ServerEndpoint {
	readonly path: string;
	release(): Promise<void>;
}

export interface ServerEndpointOptions {
	/** Temp roots to try, in order (default: the OS temp directory, this user's runtime directory, then `/tmp`). */
	readonly roots?: readonly string[];
	/** Start-time reader for the owner record (default: the UTC reader the reaper also uses). */
	readonly readStartTime?: (pid: number) => Promise<string | undefined>;
}

/**
 * The server endpoint lives next to the public socket when that path fits. In a deeper server directory it moves to a
 * fresh 0700 directory of this user's under the first guarded root - the OS temp directory, then this user's
 * `XDG_RUNTIME_DIR`, then `/tmp` - as the RPC host's internal socket does (senpi#3487): the server could bind the long
 * path through its short bind-and-link, but nothing could connect to it, so the coordinator dropped every client and
 * the server retired without one (senpi#6522).
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
		// A start time the probe cannot read is recorded as null, and the sweep then keeps this directory for as long as
		// this pid lives. The probe is bounded and retried once, because a starved probe is the common cause.
		const readStartTime = options.readStartTime ?? readEndpointOwnerStartTime;
		const processStartTime =
			(await readStartTime(process.pid).catch(() => undefined)) ??
			(await readStartTime(process.pid).catch(() => undefined));
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
 * The OS temp directory first, then the per-user runtime directory, then the shared `/tmp`; each is used only when it
 * is guarded, so an unguarded TMPDIR falls back to this user's runtime directory before the shared root.
 */
function defaultServerEndpointRoots(): readonly string[] {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	return [...new Set([tmpdir(), ...(runtimeDir === undefined || runtimeDir === "" ? [] : [runtimeDir]), "/tmp"])];
}

/** A directory with NO owner record at all is removed only once no starting server could still be writing one. */
const OWNERLESS_MIN_AGE_MS = 300_000;

/**
 * The probe that reads an owner's start time, bounded so a starved `ps` cannot hold a sweep (or a server's own
 * startup) for long; it reads in UTC, like the record, so a server and a later sweep in different time zones agree.
 *
 * Worst case per directory in a sweep: `processMatchesPidFile` makes up to 5 attempts of this 5 s probe with 200 ms
 * between them, about 26 s, all asynchronous (the sweep checks liveness with a signal, never a synchronous `ps`, so it
 * never blocks the event loop); the writer spends at most two attempts, about 10 s. Both stay inside the activator's
 * 120 s startup wait.
 */
const OWNER_PROBE_TIMEOUT_MS = 5_000;
export function readEndpointOwnerStartTime(pid: number): Promise<string | undefined> {
	return readProcessIdentity(pid, process.platform, OWNER_PROBE_TIMEOUT_MS, undefined, "UTC").then((identity) => {
		if (identity.kind === "error") throw identity.error;
		return identity.kind === "present" ? identity.identity : undefined;
	});
}

function parseOwnerRecord(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * Removes this user's `senpi-xs-*` endpoint directories under `roots` whose server is gone, as a killed server leaves
 * them behind. ONE rule decides: a record naming a pid holds the directory for as long as that process lives - proved
 * by its recorded start time where there is one, and by the pid alone where the start time could not be read - and a
 * directory whose record is missing, unreadable or unparsable is held for OWNERLESS_MIN_AGE_MS, while a server could
 * still be writing one.
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
							const unclaimedTooLong = stats.mtimeMs <= Date.now() - OWNERLESS_MIN_AGE_MS;
							const raw = await readFile(join(directory, ".owner"), "utf8").catch(() => undefined);
							// A record that does not parse claims nobody, so it follows the no-record rule rather than
							// holding its directory for ever through the catch below.
							const owner: unknown = raw === undefined ? undefined : parseOwnerRecord(raw);
							const pid: unknown =
								typeof owner === "object" && owner !== null ? Reflect.get(owner, "pid") : undefined;
							const processStartTime: unknown =
								typeof owner === "object" && owner !== null
									? Reflect.get(owner, "processStartTime")
									: undefined;
							if (typeof pid !== "number") {
								// No record at all (or an unreadable one): nobody has claimed this directory.
								if (unclaimedTooLong) await rm(directory, { recursive: true, force: true });
								return;
							}
							if (typeof processStartTime !== "string" || processStartTime.length === 0) {
								// Claimed, but the writer's own probe was starved, so only the pid is left to judge by, however old
								// the directory is. `processIsLive` counts a zombie and an EPERM answer as alive, so the directory
								// outlives its server only until that pid is gone - and a pid the OS has recycled since holds it
								// too, which costs one stale directory rather than unlinking a live server's socket.
								if (!processIsLive(pid)) await rm(directory, { recursive: true, force: true });
								return;
							}
							// `processIsLive` is a signal, not the default synchronous `ps`: a sweep over several live servers'
							// directories never blocks the event loop. It counts a zombie as alive, which only holds a directory.
							const alive = await processMatchesPidFile(
								{ pid, processStartTime },
								readEndpointOwnerStartTime,
								processIsLive,
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
