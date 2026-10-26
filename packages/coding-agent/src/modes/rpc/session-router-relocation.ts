import { SESSION_RELOCATION_CAPABILITY } from "./custom-capability.ts";
import type { RouterContext } from "./session-router-context.ts";

/**
 * The connection that offers to continue this session on another computer: the earliest-attached one that
 * advertised `session_relocation` in its own `set_client_info` (docs/rpc.md). Only it is asked and only it may answer.
 */
export function relocationConnection(host: RouterContext, sessionId: string): string | undefined {
	return host.attachOrder
		.connections(sessionId)
		.find(
			(connection) =>
				host.sessionsByConnection.get(connection)?.has(sessionId) === true &&
				host.writer.getConnectionCapabilities(connection)?.includes(SESSION_RELOCATION_CAPABILITY) === true,
		);
}

/** `connection` no longer attaches to `sessionId`: its attach order and what it offered the session end. */
export function connectionLeft(host: RouterContext, sessionId: string, connection: string): void {
	host.attachOrder.detached(sessionId, connection);
	host.bindings.get(sessionId)?.connectionDetached?.(connection);
}
