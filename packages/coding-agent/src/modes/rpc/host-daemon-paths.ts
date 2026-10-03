/**
 * WHERE one socket's daemon keeps its state: the per-socket directory, the files inside it, and the
 * modes they are created with.
 *
 * Layout 2 gives every endpoint its own directory, named by the socket it serves:
 *
 *     <agentDir>/rpc-host-daemon/                 the flat directory - shared, and left legacy-empty
 *       layout.json                               { layout: 2, dir } - the only file this build writes here
 *       <sha256(canonical socket)[:16]>/          0700, one per endpoint
 *         endpoint.json                           { layout, registry_version, endpoint_kind, socket, created_at }
 *                                                 - WHICH socket this is, and what serves it
 *         host.pid                                POINTER: { layout, instance_id, generation_dir, writer }
 *         settings.json                           what the supervisor reads at boot
 *         daemon.lock  stderr.log
 *         generations/<instanceId>/               one per generation of this daemon
 *           host.pid  settings.json  scratch/
 *         reservations/                           cross-generation session-path claims
 *
 * The flat directory is deliberately missing the one file every DEPLOYED client looks for. A flat
 * `host.pid` holding `{ pid, processStartTime }` is exactly what arms their kill paths - the desktop's
 * `readManagedHost` -> takeover, and a pre-layout-2 `ensureHost` -> `stopManagedHost` - so writing one
 * would make an un-updated client replace this daemon and end every other client's sessions. Without
 * it both fail CLOSED: they see no host of their own, refuse, and leave the daemon alone. Nothing here
 * ever writes a legacy-shaped file, and nothing here ever removes one: a flat `host.pid` that DOES
 * exist belongs to a legacy host that may still be running, and is read-only to this build.
 *
 * `endpoint.json` is the endpoint's durable identity: written once and whole (linked into place), never
 * rewritten while it names this directory's socket (an ensure repairs one that does not), and the one file
 * a generation's release leaves behind - so an endpoint whose host exited (cleanly or not) can still
 * be enumerated and named. The pointer, `settings.json` and the generation directories all describe
 * a LIVE host and go with it. `endpoint_kind` says what serves the socket - a multi-session host
 * (`rpc_host`) or a terminal's control endpoint (`tui`) - and a record written before the field
 * existed is read as `rpc_host`; readers never rewrite one to add it.
 *
 * What those files CONTAIN is `host-daemon-state.ts` (settings, and the primitives every state file
 * is written through) and `host-daemon-registration.ts` (the pointer and the generation records).
 */
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { daemonDirectoryName, socketNamesDirectory } from "./host-endpoint-names.ts";
import { HostDaemonStateError } from "./host-generation-paths.ts";

export {
	canonicalEndpointPath,
	daemonDirectoryName,
	parseShardSocket,
	type ShardKind,
	sameEndpoint,
	shardKey,
	shardSocketPath,
	shardSocketPathForKey,
	socketNamesDirectory,
} from "./host-endpoint-names.ts";
export {
	createGenerationDirectory,
	generationPaths,
	HostDaemonStateError,
	type HostGenerationPaths,
} from "./host-generation-paths.ts";

/** The layout this build writes. A directory without the marker predates it and is never touched. */
export const HOST_DAEMON_LAYOUT = 2;

/** Absolute daemon directory handed to a spawned host, which binds a private socket of its own. */
export const HOST_DAEMON_DIR_ENV = "SENPI_RPC_HOST_DAEMON_DIR";

/** The `endpoint.json` schema this build writes; readers accept any record that names its socket. */
export const ENDPOINT_REGISTRY_VERSION = 1;

/** What serves an endpoint: a multi-session RPC host, or an interactive terminal's control endpoint. */
export type EndpointKind = "rpc_host" | "tui";

const DIRECTORY_MODE = 0o700;
export const HOST_STATE_FILE_MODE = 0o600;

export interface HostDaemonPaths {
	/** The endpoint these paths belong to, exactly as its directory name was derived from. */
	readonly socket: string;
	/** `<agentDir>/rpc-host-daemon`: shared by every endpoint, and by any legacy host's own state. */
	readonly flatDir: string;
	/** The only file this build writes into the flat directory: `{ layout, dir }`. */
	readonly layoutMarker: string;
	/** A LEGACY host's registration. Read-only evidence that another host may be running. */
	readonly legacyPidFile: string;
	/** This endpoint's state directory, `<flatDir>/<sha256(canonical socket)[:16]>`. */
	readonly dir: string;
	/** Durable identity `{ layout, registry_version, endpoint_kind, socket, created_at }`: survives every generation's release. */
	readonly endpointFile: string;
	/** The pointer at the current generation. Deliberately unparseable as a legacy pidfile. */
	readonly pointerFile: string;
	/** Cross-version ensure lock for this endpoint (the endpoint lock itself lives in the temp dir). */
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
	readonly generationsDir: string;
	readonly reservationsDir: string;
}

/** The files inside one endpoint's directory, for a reader that has the directory but not its socket. */
export type HostDaemonDirectory = Omit<HostDaemonPaths, "socket" | "flatDir" | "layoutMarker" | "legacyPidFile">;

/**
 * The daemon directory of ONE endpoint. Both fields are named rather than positional on purpose:
 * two strings in a row is exactly the call a refactor silently swaps, and swapping these two would
 * point a client at another socket's state.
 */
export function createHostDaemonPaths(target: {
	readonly socket: string;
	readonly agentDir?: string;
}): HostDaemonPaths {
	const flatDir = join(target.agentDir ?? getAgentDir(), "rpc-host-daemon");
	return {
		socket: target.socket,
		flatDir,
		layoutMarker: join(flatDir, "layout.json"),
		legacyPidFile: join(flatDir, "host.pid"),
		...hostDaemonDirectoryPaths(join(flatDir, daemonDirectoryName(target.socket))),
	};
}

/**
 * The files inside one endpoint's directory, for a caller that was TOLD the directory instead of
 * the socket it serves - a supervised host binds a private hop, so it cannot derive the endpoint.
 * The names live here alone, so the directory a client recomputes and the one a host is handed
 * can never drift apart.
 */
export function hostDaemonDirectoryPaths(dir: string): HostDaemonDirectory {
	return {
		dir,
		endpointFile: join(dir, "endpoint.json"),
		pointerFile: join(dir, "host.pid"),
		lockFile: join(dir, "daemon.lock"),
		settingsFile: join(dir, "settings.json"),
		stderrLog: join(dir, "stderr.log"),
		generationsDir: join(dir, "generations"),
		reservationsDir: join(dir, "reservations"),
	};
}

/**
 * Creates this endpoint's directories and publishes the flat marker. The modes are set explicitly
 * rather than left to `mkdir`, because a directory that already exists keeps whatever mode it was
 * created with - and this one holds the evidence that decides who may signal the daemon. A `tui`
 * registrant passes its kind; everything else is an `rpc_host`.
 */
export async function createDaemonDirectories(
	paths: HostDaemonPaths,
	identity: { readonly kind?: EndpointKind } = {},
): Promise<void> {
	try {
		// The flat directory may predate this layout and may hold a legacy host's files: it is created
		// when missing and never re-moded, so a legacy host keeps whatever it set up for itself.
		await mkdir(paths.flatDir, { recursive: true, mode: DIRECTORY_MODE });
		for (const directory of [paths.dir, paths.generationsDir, paths.reservationsDir]) {
			await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
			await chmod(directory, DIRECTORY_MODE);
		}
		await writeFile(
			paths.layoutMarker,
			`${JSON.stringify({ layout: HOST_DAEMON_LAYOUT, dir: basename(paths.dir) })}\n`,
			{ mode: HOST_STATE_FILE_MODE },
		);
	} catch (cause) {
		throw new HostDaemonStateError(paths.dir, cause);
	}
	await ensureEndpointIdentity(paths, paths.socket, identity);
}

/**
 * Writes `endpoint.json` when it is absent and never rewrites a valid one: the first writer's
 * `created_at` is the endpoint's birth. The file is written whole to a temporary name and LINKED
 * into place, so a reader never sees it half-written and a second writer racing the first loses on
 * the link rather than replacing it. `repair` - asserted only by an ensure under this socket's ensure
 * lock, where `gc` cannot be deciding about the directory - also replaces a file that does not name a
 * socket of this directory (torn by a crash of an older build, or foreign), which would otherwise
 * leave the endpoint unaddressable, and never `gc`-able, for good.
 *
 * A filesystem without hard links (exFAT/FAT, some network and FUSE mounts: `link()` fails with
 * ENOTSUP, EPERM, ENOSYS...) gets the exclusive create of the final file instead. That write is not
 * atomic, but the first writer still wins, and a file torn by a crash is exactly what `repair` rewrites.
 */
export async function ensureEndpointIdentity(
	paths: HostDaemonPaths,
	socket: string,
	options: { readonly repair?: boolean; readonly kind?: EndpointKind } = {},
): Promise<void> {
	const temporary = `${paths.endpointFile}.${process.pid}-${randomUUID()}.tmp`;
	try {
		await mkdir(paths.dir, { recursive: true, mode: DIRECTORY_MODE });
		const record = `${JSON.stringify({
			layout: HOST_DAEMON_LAYOUT,
			registry_version: ENDPOINT_REGISTRY_VERSION,
			endpoint_kind: options.kind ?? "rpc_host",
			socket,
			created_at: new Date().toISOString(),
		})}\n`;
		await writeFile(temporary, record, { mode: HOST_STATE_FILE_MODE, flag: "wx" });
		const placed = await link(temporary, paths.endpointFile).then(
			() => true,
			(cause: unknown) => (isErrorCode(cause, "EEXIST") ? false : createExclusively(paths.endpointFile, record)),
		);
		if (!placed && options.repair === true && !(await namesThisDirectory(paths))) {
			await rename(temporary, paths.endpointFile);
		}
	} catch (cause) {
		throw new HostDaemonStateError(paths.endpointFile, cause);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** The pre-link write: create the file only if absent. `false` when another writer got there first. */
async function createExclusively(path: string, content: string): Promise<boolean> {
	try {
		await writeFile(path, content, { mode: HOST_STATE_FILE_MODE, flag: "wx" });
		return true;
	} catch (cause) {
		if (isErrorCode(cause, "EEXIST")) return false;
		throw cause;
	}
}

function isErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

async function namesThisDirectory(paths: HostDaemonPaths): Promise<boolean> {
	let record: unknown;
	try {
		record = JSON.parse(await readFile(paths.endpointFile, "utf8"));
	} catch {
		return false;
	}
	if (typeof record !== "object" || record === null || !("socket" in record)) return false;
	return (
		typeof record.socket === "string" &&
		record.socket !== "" &&
		socketNamesDirectory(record.socket, basename(paths.dir))
	);
}
