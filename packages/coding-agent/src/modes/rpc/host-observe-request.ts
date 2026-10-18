/**
 * Which public-socket connections count as host activity.
 *
 * The supervisor keeps a host alive while a client is attached, so anything that merely LOOKS at a
 * host - `senpi host status [--all]`, a doctor loop, a runtime panel polling every endpoint - would
 * otherwise reset the idle window on every poll and keep every shard alive forever. A read marks
 * itself with `observe: true`; the supervisor classifies a connection by the requests it sends, and
 * only a connection that sends something other than an observing read becomes an attachment.
 *
 * Only the side-effect-free reads can observe (`get_effect_status` answers a receipt and changes nothing): `observe: true` on any other command is ignored
 * and the connection attaches, so a client cannot hold a session while its host idles out under it.
 * `warm` never attaches, marked or not: it opens nothing, so a host that only received it idles out
 * on its normal deadline (senpi#2314).
 * Hosts that predate the field ignore it (commands are parsed by `type`), so a marked read works
 * against every generation.
 *
 * A request may also name the host generation its client runs INSIDE (`origin_host_instance`). A host's
 * sessions reach other sessions on the same endpoint through its public socket - an omo task tree keys
 * its `p` shard by the root session, so a child in that shard opens its own children on the very shard
 * it lives in - and counted as occupancy, those connections held the shard open forever after its owner
 * and every outside client were gone (senpi#3272). A host treats a connection from its own generation
 * as DEPENDENT: it neither holds the host nor blocks its exit. This lives here, not in a module of its
 * own, because the supervisor's import graph is a budget (`supervisor-import-graph.test.ts`).
 */

import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";

export const OBSERVE_REQUEST_FIELD = "observe";
export const ORIGIN_HOST_INSTANCE_FIELD = "origin_host_instance";

const OBSERVING_COMMANDS: ReadonlySet<unknown> = new Set([
	"get_protocol_info",
	"list_sessions",
	"subscribe_sessions",
	"unsubscribe_sessions",
	"get_effect_status",
	"get_subscription_limits",
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
	if (record.type === "warm") return true;
	return record[OBSERVE_REQUEST_FIELD] === true && OBSERVING_COMMANDS.has(record.type);
}

/** The host generation this process runs in, or undefined outside any host. */
export function originHostInstance(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const instance = env[HOST_INSTANCE_ID_ENV]?.trim();
	return instance ? instance : undefined;
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
