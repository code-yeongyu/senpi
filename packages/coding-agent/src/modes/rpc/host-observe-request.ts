/**
 * Which public-socket connections count as host activity.
 *
 * The supervisor keeps a host alive while a client is attached, so anything that merely LOOKS at a
 * host - `senpi host status [--all]`, a doctor loop, a runtime panel polling every endpoint - would
 * otherwise reset the idle window on every poll and keep every shard alive forever. A read marks
 * itself with `observe: true`; the supervisor classifies a connection by the requests it sends, and
 * only a connection that sends something other than an observing read becomes an attachment.
 *
 * Only the two side-effect-free reads can observe: `observe: true` on any other command is ignored
 * and the connection attaches, so a client cannot hold a session while its host idles out under it.
 * `warm` never attaches, marked or not: it opens nothing, so a host that only received it idles out
 * on its normal deadline (senpi#2314).
 * Hosts that predate the field ignore it (commands are parsed by `type`), so a marked read works
 * against every generation.
 */

export const OBSERVE_REQUEST_FIELD = "observe";

const OBSERVING_COMMANDS: ReadonlySet<unknown> = new Set(["get_protocol_info", "list_sessions"]);

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
