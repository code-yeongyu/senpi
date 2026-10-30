import type { RpcCommand } from "./rpc-types.ts";

/** Whether the command itself refreshes activity, apart from attached-client keepalives. */
const observations: ReadonlySet<string> = new Set([
	"get_state",
	"get_snapshot",
	"get_effect_status",
	"get_pending_inputs",
	"get_messages",
	"get_entries",
	"get_tree",
	"get_fork_messages",
	"get_last_assistant_text",
	"get_session_stats",
	"resolve_path",
	"get_steering_messages",
	"get_follow_up_messages",
	"get_available_models",
	"get_available_thinking_levels",
	"get_model_thinking_level",
	"get_fast_mode",
	"get_commands",
	"get_loaded_surfaces",
	"get_media",
	"get_auth_providers",
	"get_provider_accounts",
	"memory_report",
	"eval_cells.list",
	"eval_cells.peek",
] satisfies readonly RpcCommand["type"][]);

export function refreshesSessionActivity(command: string): boolean {
	return !observations.has(command);
}
