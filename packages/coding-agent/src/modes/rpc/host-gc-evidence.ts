/**
 * The evidence `host gc` needs before it may remove an endpoint: whether anything still runs behind
 * it, and whether anything still answers on it. Each answer errs toward "alive" - a record that
 * cannot be proven dead, a probe that neither connects nor is refused, a claim whose owner cannot be
 * read - because the cost of keeping a dead directory is disk, and the cost of removing a live one
 * is every session its host holds.
 *
 * Reading only: nothing here writes, unlinks or signals.
 */
import { lstat, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	parseDaemonPidFile,
	processMatchesPidFile,
} from "../app-server/daemon/process.ts";
import { generationPaths, type HostDaemonDirectory } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { claimOwnerIsLive, readSessionPathClaims } from "./host-reservations.ts";
import { readSocketSecret, resolveSocketTransportAddress, socketSecretPath } from "./socket-transport.ts";

export type EndpointInUse = "live_generation" | "live_claim" | "reachable";

export type SocketSilence = "socket_refused" | "socket_absent";

/** A connect that neither succeeds nor fails within this budget counts as an answer. */
const SOCKET_PROBE_TIMEOUT_MS = 2_000;

/**
 * The three-part test, in the order its answers are reported: (a) no generation pidfile names a live
 * process - the pointer's generation included, since its record lives under `generations/` too - (b) no
 * session-path claim has a live owner, (c) the public socket - and every `.next-*` successor bind beside
 * it - refuses the connection or does not exist.
 */
export async function endpointInUse(
	paths: HostDaemonDirectory,
	socket: string,
): Promise<{ readonly inUse: EndpointInUse } | { readonly inUse: undefined; readonly silence: SocketSilence }> {
	if (await anyGenerationLive(paths)) return { inUse: "live_generation" };
	for (const claim of await readSessionPathClaims(paths.reservationsDir)) {
		if (await claimOwnerIsLive(claim.owner)) return { inUse: "live_claim" };
	}
	const silence = await socketSilence(socket);
	if (silence === undefined) return { inUse: "reachable" };
	// A successor mid-handoff listens on `<socket>.next-<gen>` before it registers anywhere.
	const successors = (await socketSiblings(socket)).filter((name) => name.startsWith(`${basename(socket)}.next-`));
	for (const successor of successors) {
		if ((await socketSilence(join(dirname(socket), successor))) === undefined) return { inUse: "reachable" };
	}
	return { inUse: undefined, silence };
}

/** Every entry beside `socket` that belongs to it: `<name>.next-*` successor binds and `<name>.shield-*`. */
export async function socketSiblings(socket: string): Promise<readonly string[]> {
	const name = basename(socket);
	const entries = await readdir(dirname(socket)).catch(() => [] as string[]);
	return entries.filter((entry) => entry.startsWith(`${name}.next-`) || entry.startsWith(`${name}.shield-`));
}

/**
 * EVERY generation, not only the pointer's: a predecessor draining after a handoff is still serving.
 * Also the "dead" half of `classifyEndpointLiveness`, so the verdict and gc never disagree about it.
 */
export async function anyGenerationLive(paths: HostDaemonDirectory): Promise<boolean> {
	for (const instanceId of await readdir(paths.generationsDir).catch(() => [] as string[])) {
		const record = generationRecord(await readFileOrUndefined(generationPaths(paths, instanceId).pidFile));
		if (record !== undefined && (await recordIsLive(record))) return true;
	}
	return false;
}

/**
 * A pidfile's process, or nothing when it names none. A record whose identity guard does not parse
 * still names a pid, and is read as unguarded rather than as absent: its process may be running.
 */
function generationRecord(text: string | undefined): DaemonPidFile | undefined {
	if (text === undefined) return undefined;
	const record = parseDaemonPidFile(text);
	if (record !== undefined) return record;
	const pid = parseJson(text)?.pid;
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid, processStartTime: null } : undefined;
}

/** Live and still the recorded process; a live pid whose identity cannot be read counts as live. */
async function recordIsLive(record: DaemonPidFile): Promise<boolean> {
	try {
		return await processMatchesPidFile(record);
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return true;
		throw error;
	}
}

/**
 * How the socket proved silent, or `undefined` when it did not: only ECONNREFUSED and ENOENT prove
 * nobody listens. A connect that succeeds, times out or fails any other way is treated as an answer.
 * ECONNREFUSED counts only when the entry IS a socket: Linux refuses a connect to a regular file the
 * same way it refuses a dead socket, and a file named where the socket should be is not ours to unlink.
 */
async function socketSilence(socket: string): Promise<SocketSilence | undefined> {
	let secret: Buffer | undefined;
	if (process.platform === "win32") {
		// The pipe name includes the secret; without one no client can reach the pipe either.
		secret = await readSocketSecret(socketSecretPath(socket)).catch(() => undefined);
		if (secret === undefined) return "socket_absent";
	}
	return new Promise((resolveProbe) => {
		const connection = createConnection(resolveSocketTransportAddress(socket, process.platform, secret));
		const finish = (value: SocketSilence | undefined): void => {
			clearTimeout(timeout);
			connection.destroy();
			resolveProbe(value);
		};
		const timeout = setTimeout(() => finish(undefined), SOCKET_PROBE_TIMEOUT_MS);
		connection.once("connect", () => finish(undefined));
		connection.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED") void refusedBySocket(socket).then(finish);
			else if (error.code === "ENOENT") finish("socket_absent");
			else finish(undefined);
		});
	});
}

/** A refusal proves silence only from a socket entry; an entry of any other type is an answer. */
async function refusedBySocket(socket: string): Promise<SocketSilence | undefined> {
	// Named pipes and abstract sockets have no filesystem entry to be of the wrong type.
	if (process.platform === "win32" || socket.startsWith("\0")) return "socket_refused";
	try {
		return (await lstat(socket)).isSocket() ? "socket_refused" : undefined;
	} catch (error: unknown) {
		return error instanceof Error && "code" in error && error.code === "ENOENT" ? "socket_absent" : undefined;
	}
}
