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

/** The events that belong, wholly or in part, to where the agent loop runs. */
export type LoopSideEvent = {
	[E in keyof typeof EXTENSION_EVENT_PLACEMENT]: (typeof EXTENSION_EVENT_PLACEMENT)[E] extends "runtime" ? never : E;
}[keyof typeof EXTENSION_EVENT_PLACEMENT];

/**
 * How a loop that runs away from its extensions' home (a hosted loop) reaches each loop-side event's user hooks on the
 * hand (senpi#5898): an `interceptor` is request/reply and the loop waits for its result (or effects) before it goes
 * on; a `notification` is delivered once, in order, and its effects ride the reply; `loop-only` never leaves the loop.
 *
 * Gating: the loop forwards every interceptor, whatever the hand wants, because each one decides the turn. A
 * notification (the per-token `message_update` and `provider_stream_event` included) is forwarded only while the hand's
 * `wants` lists it: the set the hand's `describe_hooks` returns, updated by every reply that carries a changed `wants`.
 */
export type LoopHookForwarding = "interceptor" | "notification" | "loop-only";

/** Every loop-side event's forwarding; adding a loop-side event fails to compile until it is classified here. */
export const LOOP_HOOK_FORWARDING = {
	session_start: "interceptor",
	held_wakes_released: "notification",
	session_hold_changed: "notification",
	session_info_changed: "notification",
	session_parked: "notification",
	session_resumed: "notification",
	session_before_switch: "interceptor",
	session_before_fork: "interceptor",
	session_before_compact: "interceptor",
	session_compact: "notification",
	session_compact_failed: "notification",
	session_shutdown: "notification",
	session_abort: "notification",
	// A handler failure refuses the move (export) or keeps the state for the next open (import), so the loop waits.
	session_move_export: "interceptor",
	session_move_import: "interceptor",
	session_before_tree: "interceptor",
	session_tree: "notification",
	context: "interceptor",
	context_with_system: "interceptor",
	before_provider_request: "interceptor",
	// The request headers can carry a credential and never leave the side that dials (CK21, `hand/hook-contract.ts`).
	before_provider_headers: "loop-only",
	// Its response headers cross only through `FORWARDED_RESPONSE_HEADERS`: a response can carry a credential too.
	after_provider_response: "notification",
	provider_stream_event: "notification",
	before_agent_start: "interceptor",
	agent_start: "notification",
	agent_end: "notification",
	agent_before_settle: "interceptor",
	agent_settled: "notification",
	session_control_wake: "notification",
	turn_start: "notification",
	turn_end: "interceptor",
	message_start: "notification",
	message_update: "notification",
	message_end: "interceptor",
	model_select: "interceptor",
	provider_login_start: "interceptor",
	system_prompt_change: "notification",
	thinking_level_select: "notification",
	input: "interceptor",
	input_disposition: "notification",
} as const satisfies Record<LoopSideEvent, LoopHookForwarding>;

/**
 * The provider response headers `after_provider_response` carries to a hand: request ids, rate limits and timing. A
 * response header can carry a credential or a session (`set-cookie`, an auth challenge, an edge token) for the account
 * that dials, which never leaves the side that dials (as CK21 keeps the request headers there), so the loop sends only
 * the headers this allowlist names and the hand refuses any other. Names are lower case.
 */
export const FORWARDED_RESPONSE_HEADERS = {
	names: [
		"content-type",
		"date",
		"retry-after",
		"request-id",
		"x-request-id",
		"openai-processing-ms",
		"openai-version",
	],
	prefixes: ["x-ratelimit-", "anthropic-ratelimit-", "ratelimit-"],
} as const;

/** Whether a provider response header may cross to a hand (see `FORWARDED_RESPONSE_HEADERS`). */
export function isForwardedResponseHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		(FORWARDED_RESPONSE_HEADERS.names as readonly string[]).includes(lower) ||
		FORWARDED_RESPONSE_HEADERS.prefixes.some((prefix) => lower.startsWith(prefix))
	);
}

/** The loop-side events whose user hooks a hosted loop's hand runs. */
export type ForwardedLoopEvent = {
	[E in LoopSideEvent]: (typeof LOOP_HOOK_FORWARDING)[E] extends "loop-only" ? never : E;
}[LoopSideEvent];

/** Whether an event belongs, wholly or in part, to where the agent loop runs (`loop` or `split`). */
export function isLoopSideEvent(event: ExtensionEvent["type"]): boolean {
	return EXTENSION_EVENT_PLACEMENT[event] !== "runtime";
}
