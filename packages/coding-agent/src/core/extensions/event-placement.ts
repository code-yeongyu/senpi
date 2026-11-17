import type { ExtensionEvent } from "./types.ts";

export type ExtensionEventPlacement = "runtime" | "loop" | "split";

/**
 * Where each extension event belongs once the agent loop and the tool host run apart (senpi#5231): `runtime` events
 * describe the tool host's own work, `loop` events describe turns, the transcript, provider requests and model
 * selection, and `split` events have a side in each. A runner without a session manager does not dispatch `loop`
 * events through `emit`. Adding an event to `ExtensionEvent` fails to compile until it is placed here.
 */
export const EXTENSION_EVENT_PLACEMENT = {
	project_trust: "runtime",
	resources_discover: "runtime",
	mcp_servers_change: "runtime",
	session_start: "split",
	held_wakes_released: "loop",
	session_hold_changed: "loop",
	session_info_changed: "loop",
	session_parked: "split",
	session_resumed: "split",
	session_before_switch: "loop",
	session_before_fork: "loop",
	session_before_reload: "runtime",
	session_before_compact: "loop",
	session_compact: "loop",
	session_compact_failed: "loop",
	session_shutdown: "split",
	session_abort: "split",
	session_extensions_removed: "runtime",
	session_move_export: "loop",
	session_move_import: "loop",
	session_before_tree: "loop",
	session_tree: "loop",
	context: "loop",
	context_with_system: "loop",
	before_provider_request: "loop",
	before_provider_headers: "loop",
	after_provider_response: "loop",
	provider_stream_event: "loop",
	before_agent_start: "split",
	agent_start: "loop",
	agent_end: "split",
	agent_before_settle: "loop",
	agent_settled: "split",
	session_control_wake: "loop",
	ui_prompt_start: "runtime",
	ui_prompt_end: "runtime",
	turn_start: "split",
	turn_end: "loop",
	message_start: "loop",
	message_update: "loop",
	message_end: "split",
	tool_execution_start: "runtime",
	tool_execution_update: "runtime",
	tool_execution_end: "runtime",
	model_select: "loop",
	provider_login_start: "split",
	system_prompt_change: "loop",
	thinking_level_select: "loop",
	tool_activated: "runtime",
	user_bash: "runtime",
	input: "split",
	input_disposition: "loop",
	tool_call: "runtime",
	tool_result: "runtime",
} as const satisfies Record<ExtensionEvent["type"], ExtensionEventPlacement>;

/** Whether an event belongs, wholly or in part, to where the agent loop runs (`loop` or `split`). */
export function isLoopSideEvent(event: ExtensionEvent["type"]): boolean {
	return EXTENSION_EVENT_PLACEMENT[event] !== "runtime";
}
