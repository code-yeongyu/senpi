import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/** Effect-based reads only. New session commands require attachment by default. */
export const ATTACH_GATE_EXEMPT: ReadonlySet<RpcCommand["type"]> = new Set<RpcCommand["type"]>([
	"get_protocol_info",
	"list_sessions",
	"list_hands",
	"subscribe_sessions",
	"unsubscribe_sessions",
	"get_subscription_limits",
	"warm",
	"park_session",
	"claim_session",
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
	"get_project_trust",
	"get_project_settings",
	"read_project_file",
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

/**
 * Socket ownership is checked before lifecycle routing AND before worker dispatch. An unattached session command
 * is always refused (senpi#6245): the one-release grace that served and logged it (senpi#3795) has ended, so no
 * environment switch re-opens it.
 */
export function attachmentGate(host: RouterContext, command: RpcCommand): RpcResponse | undefined {
	const owner = host.writer.currentConnection();
	if (owner === undefined || ATTACH_GATE_EXEMPT.has(command.type)) return undefined;
	if (!("sessionId" in command) || command.sessionId === undefined) return undefined;
	// RULING-96: compact recovery proves token/lease authority, not an ordinary session attachment.
	if (
		host.writer.recoveryPages !== undefined &&
		(command.type === "get_recovery_page" || command.type === "release_recovery")
	)
		return undefined;
	if (
		host.writer.recoveryPages !== undefined &&
		command.type === "reset_stream" &&
		host.writer.isCompactSubscription(owner, command.admissionId, command.sessionId)
	)
		return undefined;
	if (
		command.type === "close_session" ||
		command.type === "set_session_context" ||
		command.type === "release_attachment"
	)
		return undefined;
	if (host.sessionsByConnection.get(owner)?.has(command.sessionId)) return undefined;
	return error(command.id, command.type, "session_not_attached", {
		reason: "this connection is not attached to that session",
		action: "attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }",
	});
}
