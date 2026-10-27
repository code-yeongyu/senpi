import {
	isHostOwnedToolRuntimeCapability,
	type ToolRuntimeKind,
	toolRuntimeCapabilities,
} from "../../cli/tool-runtime.ts";
import {
	ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,
	AUTO_PERMISSION_PRESET_CAPABILITY,
} from "../../core/extensions/builtin/permission-system/config.ts";
import { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from "./client-admission-record.ts";
import {
	ATTENDED_CAPABILITY,
	AUTH_KEY_VERIFY_CAPABILITY,
	AUTO_TITLE_PER_SESSION_CAPABILITY,
	AUTO_TITLE_SESSIONS_CAPABILITY,
	BROWSER_ENGINE_CAPABILITY,
	CONTINUE_FROM_LEAF_CAPABILITY,
	DETACH_CONNECTION_CAPABILITY,
	DURABLE_SESSION_ID_CAPABILITY,
	ENTRIES_TAIL_CAPABILITY,
	EVAL_CELLS_CAPABILITY,
	MEDIA_PLACEHOLDERS_CAPABILITY,
	MOVED_PATH_GUARD_CAPABILITY,
	OBSERVE_READS_CAPABILITY,
	PROMPT_SURFACE_CAPABILITY,
	PROMPT_SURFACE_CHAT_CAPABILITY,
	QUEUED_MESSAGE_REVISION_CAPABILITY,
	RESUME_SESSION_CAPABILITY,
	RETAIN_ON_DISCONNECT_CAPABILITY,
	RETRY_FALLBACK_PROFILE_CAPABILITY,
	SESSION_CONTEXT_CAPABILITY,
	SESSION_HELD_CAPABILITY,
	SESSION_KIND_CAPABILITY,
	SESSION_RELOCATION_CAPABILITY,
	SESSION_STATUS_CAPABILITY,
	TOOL_BARRIER_CAPABILITY,
	WARM_CAPABILITY,
} from "./custom-capability.ts";
import { EFFECT_LEDGER_CAPABILITY } from "./effect-record.ts";
import { STEER_WHEN_IDLE_CAPABILITY, USER_ACTIVITY_CAPABILITY } from "./rpc-types.ts";
import { MOVE_SESSION_CAPABILITY, MOVE_SESSION_REVOKE_CAPABILITY } from "./session-move-wire.ts";

/** `unload_session` and `session_parked.reason` (senpi#3225). */
export const UNLOAD_SESSION_CAPABILITY = "unload_session";

/** `get_subscription_limits` and the `subscription_limits` host record (senpi#3370). */
export const SUBSCRIPTION_LIMITS_CAPABILITY = "subscription_limits";

/** `resolve_path`: which file a message's path means, the engine's one rule (senpi#3415). */
export const RESOLVE_PATH_CAPABILITY = "resolve_path";

/**
 * The capabilities a multi-session host advertises in `get_protocol_info`, in their wire order. `warm` is added only
 * when the runtime is in-process, `tool_runtime:<kind>` names where heavy tool work runs, and `negotiated` carries
 * the launch capabilities this connection was given.
 */
export function multiSessionHostCapabilities(options: {
	readonly warm: boolean;
	readonly toolRuntime: ToolRuntimeKind;
	readonly negotiated: readonly string[];
	readonly mcpPresenters?: boolean;
}): string[] {
	return [
		...new Set([
			"multi_session",
			"snapshot_cursor",
			"ui_answer_ledger",
			"dialog_observer",
			...(options.mcpPresenters ? ["mcp_form_presenter_v1"] : []),
			"session_lifecycle",
			"expected_host_instance",
			"attach_session",
			"release_attachment",
			"release_caller_aware",
			"reclaim_session",
			AUTO_TITLE_SESSIONS_CAPABILITY,
			MEDIA_PLACEHOLDERS_CAPABILITY,
			DURABLE_CLIENT_MESSAGE_ID_CAPABILITY,
			EFFECT_LEDGER_CAPABILITY,
			SUBSCRIPTION_LIMITS_CAPABILITY,
			RESOLVE_PATH_CAPABILITY,
			STEER_WHEN_IDLE_CAPABILITY,
			CONTINUE_FROM_LEAF_CAPABILITY,
			EVAL_CELLS_CAPABILITY,
			AUTH_KEY_VERIFY_CAPABILITY,
			QUEUED_MESSAGE_REVISION_CAPABILITY,
			TOOL_BARRIER_CAPABILITY,
			USER_ACTIVITY_CAPABILITY,
			// Both shared runtimes dispatch through the active session-writing holder guard.
			SESSION_HELD_CAPABILITY,
			RESUME_SESSION_CAPABILITY,
			ATTENDED_CAPABILITY,
			// `get_state`/`get_entries` marked `observe` never attach, and history reads page backward too (senpi#4267).
			OBSERVE_READS_CAPABILITY,
			ENTRIES_TAIL_CAPABILITY,
			// Host capabilities, not client opt-ins: only a multi-session host owns the
			// attachment refcount `open_session.retain_on_disconnect` detaches from, the
			// per-session launch profile `context`/`auto_title` travel on, and the session
			// listing `kind` filters.
			RETAIN_ON_DISCONNECT_CAPABILITY,
			// Only a multi-session host tracks attachments per connection, so only it can drop them on request.
			DETACH_CONNECTION_CAPABILITY,
			// Only a multi-session host keeps sessions loaded that a client can ask it to free.
			UNLOAD_SESSION_CAPABILITY,
			// Only a multi-session host owns a move ledger and the hosted-session list export checks against.
			MOVE_SESSION_CAPABILITY,
			MOVE_SESSION_REVOKE_CAPABILITY,
			// A host session asks the client that offers it to continue the session elsewhere (`host_request`).
			SESSION_RELOCATION_CAPABILITY,
			SESSION_CONTEXT_CAPABILITY,
			SESSION_KIND_CAPABILITY,
			// Only a multi-session host sees every session, so only it can stream their status.
			SESSION_STATUS_CAPABILITY,
			AUTO_TITLE_PER_SESSION_CAPABILITY,
			// Only a multi-session host can refuse a duplicate durable id, because only it
			// sees every live session's identity.
			DURABLE_SESSION_ID_CAPABILITY,
			// Every session's open, schedule delivery and holder claim resolve paths the desktop moved.
			MOVED_PATH_GUARD_CAPABILITY,
			// Every session's prompt is built from its own launch profile, so one host serves both surfaces.
			PROMPT_SURFACE_CAPABILITY,
			PROMPT_SURFACE_CHAT_CAPABILITY,
			// Each session's tool subprocesses and eval kernel get its own OMO_BROWSER_ENGINE from its launch profile.
			BROWSER_ENGINE_CAPABILITY,
			// Each session's fallback chain is its own in-memory settings override, never the host's file.
			RETRY_FALLBACK_PROFILE_CAPABILITY,
			ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,
			AUTO_PERMISSION_PRESET_CAPABILITY,
			// Only an in-process runtime shares the loop a warm loads into (senpi#2314).
			...(options.warm ? [WARM_CAPABILITY] : []),
			...toolRuntimeCapabilities(options.toolRuntime),
			// The host alone says where tool work runs; a negotiated copy would make two answers.
			...options.negotiated.filter(
				(capability) => capability !== "mcp_form_presenter_v1" && !isHostOwnedToolRuntimeCapability(capability),
			),
		]),
	];
}
