import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import type { RpcConnectionOptions } from "./connection-handler.ts";
import { roleConnection } from "./connection-roles.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { SessionWorkerToHost } from "./session-worker-protocol.ts";
import { acknowledge } from "./session-worker-signals.ts";
type Options = Pick<RpcConnectionOptions, "capabilities" | "clientInfo" | "connectionRoles">;
/** Workers acknowledge a host-approved declaration; they never choose an actual socket's format. */
export function workerCapabilities(
	options: Options,
	message: Extract<SessionWorkerToHost, { type: "capabilities" }>,
	writer: SessionEventWriter | undefined,
): Options {
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
	if (options.connectionRoles?.declare(roleConnection(message.connection), message.capabilities) === false) {
		acknowledge(message.signal, false);
		return options;
	}
	if (message.connection === undefined) options = { ...options, capabilities: message.capabilities };
	options.clientInfo?.setCapabilities(message.connection, message.capabilities);
	acknowledge(message.signal, true);
	return options;
}
