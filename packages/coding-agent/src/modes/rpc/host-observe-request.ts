/**
 * Which public-socket connections count as host activity.
 *
 * The supervisor keeps a host alive while a client is attached, so anything that merely LOOKS at a
 * host - `senpi host status [--all]`, a doctor loop, a runtime panel polling every endpoint - would
 * otherwise reset the idle window on every poll and keep every shard alive forever. A read marks
 * itself with `observe: true`; the supervisor classifies a connection by the requests it sends, and
 * only a connection that sends something other than an observing read becomes an attachment.
 *
 * Only the side-effect-free reads can observe (`get_effect_status` answers a receipt and changes nothing; `get_state` and
 * `get_entries` read a session's state and history, senpi#4267): `observe: true` on any other command is ignored
 * and the connection attaches, so a client cannot hold a session while its host idles out under it.
 * `warm` never attaches, marked or not: it opens nothing, so a host that only received it idles out
 * on its normal deadline (senpi#2314).
 * `park_session` likewise holds no client attachment: its speculative runtime is discarded at host exit.
 * `claim_session` takes an ordinary opener attachment and is never observing.
 * Hosts that predate the field ignore it (commands are parsed by `type`), so a marked read works
 * against every generation.
 *
 * An observer may HOLD the host (senpi#5626): a remote-control daemon reads a host only through observing requests,
 * yet while a remote viewer is attached the host must not idle out under it. An observing read carrying
 * `hold_host: true` makes its connection a holder, which counts as occupancy until a later observing read carries
 * `hold_host: false` or the connection closes (a lease on the connection). Only the literal booleans on a read marked
 * `observe: true` count (`warm` and `authenticate` never hold); plain observing reads hold nothing, so looking at a
 * host still never keeps it alive. A held observer is occupancy everywhere occupancy is read: the supervisor's idle
 * exit, a socket host's empty-exit window, and the owner-death quiescence check.
 *
 * A request may also name the host generation its client runs INSIDE (`origin_host_instance`). A host's
 * sessions reach other sessions on the same endpoint through its public socket - an omo task tree keys
 * its `p` shard by the root session, so a child in that shard opens its own children on the very shard
 * it lives in - and counted as occupancy, those connections held the shard open forever after its owner
 * and every outside client were gone (senpi#3272). A host treats a connection from its own generation
 * as DEPENDENT: it neither holds the host nor blocks its exit. This lives here, not in a module of its
 * own, because the supervisor's import graph is a budget (`supervisor-import-graph.test.ts`).
 *
 * An attached connection whose sessions on the host have ALL closed stops holding it (oh-my-openagent#14272), while
 * one that never held a session (an ensure's attach hold, a client about to open) still counts, as does any open or
 * command in flight. The supervisor proxies bytes and cannot see sessions, so its observer link sends
 * `watch_host_occupancy` (an observing read) and the host answers on that connection with `host_occupancy` records
 * carrying `holders`, the number of attached connections that still occupy it, now and on every change. A parent
 * that keeps its shard connection after its last session closed then no longer keeps a 0-session host alive.
 */

import { HOST_INSTANCE_ID_ENV, ORIGIN_HOST_INSTANCE_ENV, presentInstanceId } from "./host-identity-env.ts";
import { RPC_LAUNCH_PROOF_RECORD } from "./rpc-auth-proof.ts";

export const OBSERVE_REQUEST_FIELD = "observe";
export const WATCH_HOST_OCCUPANCY = "watch_host_occupancy";
export const HOST_OCCUPANCY_RECORD = "host_occupancy";
export const ORIGIN_HOST_INSTANCE_FIELD = "origin_host_instance";
const HOLD_HOST_FIELD = "hold_host";

const OBSERVING_COMMANDS: ReadonlySet<unknown> = new Set([
	"get_protocol_info",
	"get_snapshot",
	"list_sessions",
	"subscribe_sessions",
	"unsubscribe_sessions",
	"get_effect_status",
	"get_pending_inputs",
	"get_subscription_limits",
	"get_state",
	"get_entries",
	WATCH_HOST_OCCUPANCY,
]);

export function isObservingRequest(line: string): boolean {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		return false;
	}
	if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
	const record = request as Readonly<Record<string, unknown>>;
	if (
		record.type === "warm" ||
		record.type === "park_session" ||
		record.type === "authenticate" ||
		record.type === RPC_LAUNCH_PROOF_RECORD
	)
		return true;
	return record[OBSERVE_REQUEST_FIELD] === true && OBSERVING_COMMANDS.has(record.type);
}

/**
 * A marked observing read's hold change: true takes the hold, false releases it, undefined leaves it as it is. Only a
 * read carrying `observe: true` on one of the observing commands can change it; `warm` and `authenticate` never do.
 */
export function observingHoldChange(line: string): boolean | undefined {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof request !== "object" || request === null || Array.isArray(request)) return undefined;
	const record = request as Readonly<Record<string, unknown>>;
	if (record[OBSERVE_REQUEST_FIELD] !== true || !OBSERVING_COMMANDS.has(record.type)) return undefined;
	const hold = record[HOLD_HOST_FIELD];
	return typeof hold === "boolean" ? hold : undefined;
}

/** Whether a request line is the supervisor observer's `watch_host_occupancy`; a cheap scan first, most lines are not. */
export function isHostOccupancyWatch(line: string): boolean {
	if (!line.includes(WATCH_HOST_OCCUPANCY)) return false;
	try {
		const request: unknown = JSON.parse(line);
		return typeof request === "object" && request !== null && Reflect.get(request, "type") === WATCH_HOST_OCCUPANCY;
	} catch {
		return false;
	}
}

/** The `holders` of a `host_occupancy` record line; undefined for every other line. */
export function hostOccupancyHolders(line: string): number | undefined {
	if (!line.includes(HOST_OCCUPANCY_RECORD)) return undefined;
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof record !== "object" || record === null || Reflect.get(record, "type") !== HOST_OCCUPANCY_RECORD)
		return undefined;
	const holders: unknown = Reflect.get(record, "holders");
	return typeof holders === "number" && Number.isSafeInteger(holders) && holders >= 0 ? holders : undefined;
}

/** The host generation this process runs in, or undefined outside any host. */
export function originHostInstance(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	// A host's own process holds its instance id; a child it started for an agent holds the origin (senpi#5635).
	return presentInstanceId(env[HOST_INSTANCE_ID_ENV]) ?? presentInstanceId(env[ORIGIN_HOST_INSTANCE_ENV]);
}

/** The generation a request line says its client runs in; undefined when unmarked or not JSON. */
export function requestOriginHostInstance(line: string): string | undefined {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof request !== "object" || request === null || Array.isArray(request)) return undefined;
	const origin: unknown = Reflect.get(request, ORIGIN_HOST_INSTANCE_FIELD);
	return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}
