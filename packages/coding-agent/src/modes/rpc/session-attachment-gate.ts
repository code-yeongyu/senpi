import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/**
 * Commands a connection may send for a session it does not hold (senpi#6245 review: every entry has its reason).
 * Most are effect-free reads; a few start or recover an attachment. omo's thread fence and the desktop's relay keep
 * hand-written copies of part of this list (oh-my-openagent#15293), so an entry they send unattached stays here
 * until they read the list from the engine.
 */
export const ATTACH_GATE_EXEMPT: ReadonlySet<RpcCommand["type"]> = new Set<RpcCommand["type"]>([
	// Session-less: carry no sessionId, so the gate never judges them; listed for predecessor routing and drain.
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
	// The ways a connection comes to hold a session: requiring an attachment first would make attaching impossible.
	"open_session",
	"attach_session",
	"reclaim_session",
	// Observing reads (senpi#4267): a watcher reads a session it does not drive; omo and the desktop send them unattached.
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
	"memory_report",
	"eval_cells.list",
	"eval_cells.peek",
	"check_reload_veto",
	"resolve_path",
	// Folder reads the desktop's settings panes send through the relay's folder route, which holds no session.
	"get_project_trust",
	"get_project_settings",
	"read_project_file",
	"get_project_mcp_servers",
	"read_project_skill_file",
	"read_user_skill_file",
]);

/** A host started with this variable set to "1" serves unattached session commands and logs each one (senpi#6245). */
export const ALLOW_UNATTACHED_ENV = "SENPI_RPC_ALLOW_UNATTACHED";
/**
 * The opt-out is a migration aid for a caller that has not learned to attach yet, not a security boundary: a same-user
 * process able to restart the host can also set it. Remove the variable and this constant in the first release after
 * this date.
 */
export const ALLOW_UNATTACHED_REMOVAL_DATE = "2027-01-31";

/** Read once per host at start; the stderr line says the gate is open and until when the opt-out exists. */
export function readUnattachedOptOut(
	env: Readonly<Record<string, string | undefined>>,
	write: (line: string) => void = (line) => process.stderr.write(line),
): boolean {
	if (env[ALLOW_UNATTACHED_ENV] !== "1") return false;
	write(
		`senpi rpc host: ${ALLOW_UNATTACHED_ENV}=1 serves session commands from connections not attached to the session; this opt-out is removed after ${ALLOW_UNATTACHED_REMOVAL_DATE}\n`,
	);
	return true;
}

/** A client-chosen id as one log token: control characters and quotes escaped, so it never adds a line. */
function logSafe(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

/** Socket ownership is checked before lifecycle routing AND before worker dispatch. */
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
	// senpi#6305: the forwarder's peer lane delivers an agent's message without ever attaching; only its admit passes.
	if (command.type === "admit_external_message" && host.connectionRoles.grantedByForwarder(owner, "peer_agent"))
		return undefined;
	if (host.allowUnattached !== true)
		return error(command.id, command.type, "session_not_attached", {
			reason: "this connection is not attached to that session",
			action: "attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }",
		});
	process.stderr.write(
		`senpi rpc host: ${command.type} on ${logSafe(command.sessionId)} from a connection not attached to it (served: ${ALLOW_UNATTACHED_ENV}=1)\n`,
	);
	return undefined;
}
