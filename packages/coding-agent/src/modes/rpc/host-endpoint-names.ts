/**
 * How an endpoint is NAMED: its canonical spelling, the daemon directory name every client derives from
 * it, and the shard socket names. Split out of `host-daemon-paths.ts` (senpi#2566), which re-exports
 * every name here.
 */
import { createHash } from "node:crypto";
import { basename, dirname, join, win32 } from "node:path";
import { canonicalSessionPath } from "./session-path-key.ts";

/**
 * The one spelling of an endpoint every client derives the same way. On POSIX that is the socket path
 * with its directory resolved through its deepest existing ancestor (`/tmp` vs `/private/tmp`, a
 * symlinked agent directory) - the identity the ensure lock is keyed by - and a path already spelled
 * that way comes back unchanged. On win32 it is the normalized lower-cased path the pipe name is derived
 * from. An abstract socket has no directory to resolve. Deliberately total: naming a directory must never
 * fail on a path shape the transport would reject, or a client could not even report WHERE it was looking.
 */
export function canonicalEndpointPath(socket: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return win32.normalize(socket).toLowerCase();
	if (socket.startsWith("\0")) return socket;
	return join(canonicalSessionPath(dirname(socket)), basename(socket));
}

/**
 * The directory name every client recomputes from the socket alone: `sha256(<canonical endpoint>)`, so
 * every spelling of one endpoint shares one directory, and a canonical spelling keeps the name it had
 * when the name was hashed from the spelling itself.
 */
export function daemonDirectoryName(socket: string, platform: NodeJS.Platform = process.platform): string {
	return directoryNameOf(canonicalEndpointPath(socket, platform));
}

/** Whether two spellings name one endpoint. */
export function sameEndpoint(socket: string, other: string): boolean {
	return socket === other || canonicalEndpointPath(socket) === canonicalEndpointPath(other);
}

/**
 * Whether a record naming `socket` belongs in the directory called `name`: the canonical name, or the
 * name a build that hashed the spelling itself gave it - that directory has to stay listable, and
 * therefore collectable by `host gc`, after the upgrade.
 */
export function socketNamesDirectory(socket: string, name: string): boolean {
	return daemonDirectoryName(socket) === name || (process.platform !== "win32" && directoryNameOf(socket) === name);
}

function directoryNameOf(endpoint: string): string {
	return createHash("sha256").update(endpoint, "utf8").digest("hex").slice(0, 16);
}

/**
 * The owner-keyed shard naming contract every client computes identically - senpi, omo (library
 * import) and the Desktop (a local mirror checked against `senpi host shard-path`): `p` shards belong
 * to a parent session, `i` shards to an interactive thread. The key is `sha256("<kind>:<owner>")` in
 * hex, first 16 characters; the socket is `<root>/<kind>-<key>.sock`.
 */
export type ShardKind = "p" | "i";

export function shardKey(kind: ShardKind, ownerId: string): string {
	return createHash("sha256").update(`${kind}:${ownerId}`, "utf8").digest("hex").slice(0, 16);
}

/** The socket of a shard whose key is already known. No hashing: the key IS the name. */
export function shardSocketPathForKey(root: string, kind: ShardKind, key: string): string {
	return join(root, `${kind}-${key}.sock`);
}

export function shardSocketPath(root: string, kind: ShardKind, ownerId: string): string {
	return shardSocketPathForKey(root, kind, shardKey(kind, ownerId));
}

const SHARD_SOCKET_NAME = /^(p|i)-([0-9a-f]{16})\.sock$/;

/** Which shard a socket names, from its basename alone; `null` for any other endpoint. */
export function parseShardSocket(socket: string): { readonly kind: ShardKind; readonly key: string } | null {
	const match = SHARD_SOCKET_NAME.exec(basename(socket));
	const key = match?.[2];
	if (key === undefined) return null;
	return { kind: match?.[1] === "i" ? "i" : "p", key };
}
