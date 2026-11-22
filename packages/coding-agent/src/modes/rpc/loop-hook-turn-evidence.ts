import type { ForwardedLoopEvent } from "../../core/extensions/event-placement.ts";
import type { LoopTurnEvidence } from "./loop-hook-call.ts";

type TurnEvidenceOf = (payload: Readonly<Record<string, unknown>>) => LoopTurnEvidence | undefined;

function none(): undefined {
	return undefined;
}

function running(): LoopTurnEvidence {
	return "running";
}

/**
 * What each forwarded loop event proves about its loop session's turn, for a Stop the hand holds for background work
 * (#6770 review M1, round 2 M1 and L1). It is typed over every forwarded event, so forwarding a new one fails to
 * compile until it is classified here. `"ended"` begins the session's idleness after a turn, and `"running"` ends it.
 * An event counts as `"running"` only if it is emitted when a turn starts and nowhere else: message and provider
 * events also arrive for messages and auxiliary requests outside a turn, `context` also for previews, and the rest of
 * a turn follows a start that already counted.
 */
export const TURN_EVIDENCE = {
	// A continuation turn (auto-retry, compaction recovery, a queued or `agent_before_settle` continuation) starts with
	// these and no before_agent_start. The hooks builtin's Stop lifecycle listens to agent_start, so a hand that holds
	// a Stop always wants it, and the loop forwards it.
	agent_start: running,
	turn_start: running,
	// A preview composes a turn's prompt without starting the turn.
	before_agent_start: (payload) => (payload.preview === true ? undefined : running()),
	// A model request sent mid-turn. The loop forwards it only to a hand that advertises a request hook.
	before_provider_request: (payload) => (payload.idle === false ? running() : undefined),
	agent_end: () => "ended",
	session_start: none,
	held_wakes_released: none,
	session_hold_changed: none,
	session_info_changed: none,
	session_parked: none,
	session_resumed: none,
	session_before_switch: none,
	session_before_fork: none,
	session_before_compact: none,
	session_compact: none,
	session_compact_failed: none,
	session_shutdown: none,
	session_abort: none,
	session_move_export: none,
	session_move_import: none,
	session_before_tree: none,
	session_tree: none,
	context: none,
	context_with_system: none,
	after_provider_response: none,
	provider_stream_event: none,
	agent_before_settle: none,
	agent_settled: none,
	session_control_wake: none,
	turn_end: none,
	message_start: none,
	message_update: none,
	message_end: none,
	model_select: none,
	provider_login_start: none,
	system_prompt_change: none,
	thinking_level_select: none,
	// The loop may handle an input without a turn; a turn it starts arrives as before_agent_start or agent_start.
	input: none,
	input_disposition: none,
} as const satisfies Record<ForwardedLoopEvent, TurnEvidenceOf>;
