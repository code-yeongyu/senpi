import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import type { RpcConnectionOptions } from "./connection-handler.ts";
import { roleConnection } from "./connection-roles.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { SessionWorkerToHost } from "./session-worker-protocol.ts";
import { acknowledge, acknowledgeGrant } from "./session-worker-signals.ts";
type Options = Pick<RpcConnectionOptions, "capabilities" | "clientInfo" | "connectionRoles">;
/** Workers acknowledge a host-approved declaration; they never choose an actual socket's format. */
export function workerCapabilities(
	options: Options,
	message: Extract<SessionWorkerToHost, { type: "capabilities" }>,
	writer: SessionEventWriter | undefined,
): Options {
	const connection = roleConnection(message.connection);
	// omo-relay-daemon#307 (v5 review H1): a declaration from a retired incarnation is answered `stale` BEFORE the compact
	// check, which would otherwise answer code 2 and end the shared worker. Nothing is declared or applied for it.
	if (options.connectionRoles?.isStale(connection, message.incarnation) === true) {
		acknowledgeGrant(message.signal, "stale");
		return options;
	}
	// RULING-111: only the compact negotiation pins a socket's selection; with the flag off workers declare as on main.
	const current =
		message.connection === undefined || !compactUpdatesEnabled()
			? undefined
			: writer?.compactSelection(message.connection);
	if (
		current &&
		(current.refused ||
			message.capabilities.length !== current.capabilities.length ||
			!message.capabilities.every((cap) => current.capabilities.includes(cap)))
	) {
		acknowledge(message.signal, false);
		return options;
	}
	// The claim is committed only after the compact check, so a malformed current declaration fixes no claim.
	const verdict = options.connectionRoles?.declare(connection, message.capabilities, message.incarnation);
	if (verdict === "stale") {
		acknowledgeGrant(message.signal, "stale");
		return options;
	}
	if (verdict === "fixed") {
		acknowledge(message.signal, false);
		return options;
	}
	if (message.connection === undefined) options = { ...options, capabilities: message.capabilities };
	options.clientInfo?.setCapabilities(message.connection, message.capabilities);
	acknowledge(message.signal, true);
	return options;
}
