/**
 * `move_session` as the multi-session router runs it (senpi#3676): this host's agent directory and hosted paths, and the
 * open an `import` asks for with `open` (senpi#6267), which meets the gates an `open_session` from that connection would.
 */
import { compactAdmissionGate } from "./compact-socket-commands.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { moveSession } from "./session-move-commands.ts";
import type { RpcMoveSessionCommand } from "./session-move-wire.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";
import { openWithBarrier } from "./session-router-open.ts";

export function routeMoveSession(
	host: RouterContext,
	command: RpcMoveSessionCommand,
): Promise<RpcResponse | undefined> {
	// The registry's directory only, never the host's own: a host that runs its sessions in workers has a directory and
	// still does not move sessions. `find_session` reads the host's own; that must not switch this on.
	const agentDir = host.registry.agentDir;
	if (agentDir === undefined)
		return Promise.resolve(
			error(command.id, command.type, "move_unsupported: this host keeps no agent directory to move sessions in"),
		);
	return moveSession(
		{
			agentDir,
			hostedPaths: () =>
				host.registry.list().flatMap((row) => (row.sessionPath === undefined ? [] : [row.sessionPath])),
			open: async (open, reply) => {
				if (host.draining) return error(open.id, open.type, "host_draining");
				return compactAdmissionGate(host, open) ?? openWithBarrier(host, open, reply);
			},
		},
		command,
	);
}
