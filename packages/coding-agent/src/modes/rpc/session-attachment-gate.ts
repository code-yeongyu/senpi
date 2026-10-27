import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/** Effect-based reads only. New session commands require attachment by default. */
export const ATTACH_GATE_EXEMPT: ReadonlySet<RpcCommand["type"]> = new Set<RpcCommand["type"]>([
	"get_protocol_info",
	"list_sessions",
	"subscribe_sessions",
	"unsubscribe_sessions",
	"get_subscription_limits",
	"warm",
	"detach_connection",
	"open_session",
	"attach_session",
	"reclaim_session",
	"get_effect_status",
	"get_state",
	"get_snapshot",
	"get_messages",
	"get_entries",
	"get_tree",
	"get_fork_messages",
	"get_last_assistant_text",
	"get_media",
	"get_commands",
	"get_loaded_surfaces",
	"get_available_models",
	"get_available_thinking_levels",
	"get_fast_mode",
	"get_session_stats",
	"get_pending_inputs",
	"get_steering_messages",
	"get_follow_up_messages",
	"get_auth_providers",
	"get_provider_accounts",
	"resolve_path",
	"memory_report",
	"eval_cells.list",
	"eval_cells.peek",
	"check_reload_veto",
]);

/** A client-chosen id as one log token: control characters and quotes escaped, so it never adds a line. */
function logSafe(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

/** Socket ownership is checked before lifecycle routing AND before worker dispatch. */
export function attachmentGate(host: RouterContext, command: RpcCommand): RpcResponse | undefined {
	const owner = host.writer.currentConnection();
	if (owner === undefined || ATTACH_GATE_EXEMPT.has(command.type)) return undefined;
	if (!("sessionId" in command) || command.sessionId === undefined) return undefined;
	if (
		command.type === "close_session" ||
		command.type === "set_session_context" ||
		command.type === "release_attachment"
	)
		return undefined;
	if (host.sessionsByConnection.get(owner)?.has(command.sessionId)) return undefined;
	if (process.env.SENPI_RPC_REQUIRE_ATTACH === "1")
		return error(command.id, command.type, "session_not_attached", {
			reason: "this connection is not attached to that session",
			action: "attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }",
		});
	process.stderr.write(
		`senpi rpc host: ${command.type} on ${logSafe(command.sessionId)} from a connection not attached to it (refused from the next release)\n`,
	);
	return undefined;
}
