import { describe, expect, it } from "vitest";
import { EXTENSION_EVENT_PLACEMENT } from "../../src/core/extensions/runner.ts";

function eventsPlaced(placement: "runtime" | "loop" | "split"): string[] {
	return Object.entries(EXTENSION_EVENT_PLACEMENT)
		.filter(([, value]) => value === placement)
		.map(([event]) => event)
		.sort();
}

describe("every extension event has a placement (RT11)", () => {
	it("places the tool host's own work on the runtime", () => {
		expect(eventsPlaced("runtime")).toEqual(
			[
				"mcp_servers_change",
				"project_trust",
				"resources_discover",
				"session_before_reload",
				"session_extensions_removed",
				"tool_activated",
				"tool_call",
				"tool_execution_end",
				"tool_execution_start",
				"tool_execution_update",
				"tool_result",
				"ui_prompt_end",
				"ui_prompt_start",
				"user_bash",
			].sort(),
		);
	});

	it("places turns, the transcript, provider requests and model selection on the loop", () => {
		expect(eventsPlaced("loop")).toEqual(
			[
				"agent_before_settle",
				"agent_start",
				"after_provider_response",
				"before_provider_headers",
				"before_provider_request",
				"context",
				"context_with_system",
				"held_wakes_released",
				"input_disposition",
				"message_start",
				"message_update",
				"model_select",
				"provider_stream_event",
				"session_before_compact",
				"session_before_fork",
				"session_before_switch",
				"session_before_tree",
				"session_compact",
				"session_compact_failed",
				"session_control_wake",
				"session_hold_changed",
				"session_info_changed",
				"session_move_export",
				"session_move_import",
				"session_tree",
				"system_prompt_change",
				"thinking_level_select",
				"turn_end",
			].sort(),
		);
	});

	it("marks the events with a runtime side and a loop side as split", () => {
		expect(eventsPlaced("split")).toEqual(
			[
				"agent_end",
				"agent_settled",
				"before_agent_start",
				"input",
				"message_end",
				"provider_login_start",
				"session_abort",
				"session_parked",
				"session_resumed",
				"session_shutdown",
				"session_start",
				"turn_start",
			].sort(),
		);
	});
});
