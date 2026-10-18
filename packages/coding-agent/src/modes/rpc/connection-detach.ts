import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

/**
 * Answer `detach_connection` only after the asking connection's attachments are released (senpi#3238).
 * A plain socket close releases them too, but asynchronously, so another connection could still see the
 * attachment right after a short-lived client returned. `deferred` names the sessions still counting it:
 * one whose running turn this release would end (it releases when the turn settles), or every session
 * while the host drains.
 */
export async function detachConnection(
	command: Extract<RpcCommand, { type: "detach_connection" }>,
	connectionId: string | undefined,
	release: (connectionId: string) => Promise<readonly string[]>,
): Promise<RpcResponse> {
	if (connectionId === undefined) {
		return {
			id: command.id,
			type: "response",
			command: "detach_connection",
			success: false,
			error: "detach_connection needs a socket connection",
		};
	}
	const deferred = await release(connectionId);
	return {
		id: command.id,
		type: "response",
		command: "detach_connection",
		success: true,
		data: { deferred: [...deferred] },
	};
}
