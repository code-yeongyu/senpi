import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
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
	ACCOUNT_RESET_CAPABILITY,
	ATTENDED_CAPABILITY,
	AUTH_KEY_VERIFY_CAPABILITY,
	AUTO_TITLE_PER_SESSION_CAPABILITY,
	AUTO_TITLE_SESSIONS_CAPABILITY,
	BROWSER_ENGINE_CAPABILITY,
	CONTINUE_FROM_LEAF_CAPABILITY,
	DELEGATED_CONNECTION_CAPABILITY,
	DELEGATION_ROLES_CAPABILITY,
	DETACH_CONNECTION_CAPABILITY,
	DURABLE_SESSION_ID_CAPABILITY,
	PEER_AGENT_ROLE_CAPABILITY,
	SAME_ACCOUNT_DELEGATION_CAPABILITY,
	ENTRIES_TAIL_CAPABILITY,
	EVAL_CELLS_CAPABILITY,
	MEDIA_PLACEHOLDERS_CAPABILITY,
	MOVED_PATH_GUARD_CAPABILITY,
	OBSERVE_READS_CAPABILITY,
	PROMPT_SURFACE_CAPABILITY,
	PROMPT_SURFACE_CHAT_CAPABILITY,
	PROVIDER_ACCOUNT_TEST_CAPABILITY,
	QUEUED_MESSAGE_REVISION_CAPABILITY,
	RESUME_SESSION_CAPABILITY,
	RETAIN_ON_DISCONNECT_CAPABILITY,
	RETRY_FALLBACK_PROFILE_CAPABILITY,
	SESSION_CONTEXT_CAPABILITY,
	SESSION_ENV_CAPABILITY,
	SESSION_HELD_CAPABILITY,
	SESSION_KIND_CAPABILITY,
	SESSION_RELOCATION_CAPABILITY,
	SESSION_STATUS_CAPABILITY,
	TOOL_BARRIER_CAPABILITY,
	WARM_CAPABILITY,
	PARK_CLAIM_CAPABILITY,
} from "./custom-capability.ts";
import { EFFECT_LEDGER_CAPABILITY } from "./effect-record.ts";
import { SESSION_MODEL_SCOPE_CAPABILITY } from "./rpc-session-command-types.ts";
import { STEER_WHEN_IDLE_CAPABILITY, USER_ACTIVITY_CAPABILITY } from "./rpc-types.ts";
import {
	MOVE_SESSION_CAPABILITY,
	MOVE_SESSION_COPY_CAPABILITY,
	MOVE_SESSION_REVOKE_CAPABILITY,
} from "./session-move-wire.ts";

/** `unload_session` and `session_parked.reason` (senpi#3225). */
export const UNLOAD_SESSION_CAPABILITY = "unload_session";

/** `get_subscription_limits` and the `subscription_limits` host record (senpi#3370). */
export const SUBSCRIPTION_LIMITS_CAPABILITY = "subscription_limits";

/** `resolve_path`: which file a message's path means, the engine's one rule (senpi#3415). */
export const RESOLVE_PATH_CAPABILITY = "resolve_path";

/** `find_session`: which session file of this host carries a durable id, read-only (senpi#6429). */
const FIND_SESSION_CAPABILITY = "find_session";

/** `set_permission_preset`: a live session's approval mode can be set and is echoed back (classic and multi-session). */
export const SET_PERMISSION_PRESET_CAPABILITY = "set_permission_preset_v1";

/**
 * The capabilities a multi-session host advertises in `get_protocol_info`, in their wire order. `warm` is added only
 * when the runtime is in-process, `tool_runtime:<kind>` names where heavy tool work runs, and `negotiated` carries
 * the launch capabilities this connection was given.
 */
export function multiSessionHostCapabilities(options: {
	readonly warm: boolean;
	readonly parkClaim?: boolean;
	readonly toolRuntime: ToolRuntimeKind;
	readonly negotiated: readonly string[];
	readonly mcpPresenters?: boolean;
}): string[] {
	return [
		...new Set([
			"multi_session",
			"snapshot_cursor",
			"ui_answer_ledger",
			"secret_input_v1",
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
			// Only a multi-session host keeps the agent directory whose session files this looks in.
			FIND_SESSION_CAPABILITY,
			STEER_WHEN_IDLE_CAPABILITY,
			CONTINUE_FROM_LEAF_CAPABILITY,
			EVAL_CELLS_CAPABILITY,
			AUTH_KEY_VERIFY_CAPABILITY,
			PROVIDER_ACCOUNT_TEST_CAPABILITY,
			ACCOUNT_RESET_CAPABILITY,
			QUEUED_MESSAGE_REVISION_CAPABILITY,
			TOOL_BARRIER_CAPABILITY,
			USER_ACTIVITY_CAPABILITY,
			SESSION_MODEL_SCOPE_CAPABILITY,
			// Both shared runtimes dispatch through the active session-writing holder guard.
			SESSION_HELD_CAPABILITY,
			RESUME_SESSION_CAPABILITY,
			ATTENDED_CAPABILITY,
			// `get_state`/`get_entries` marked `observe` never attach, and history reads page backward too (senpi#4267).
			OBSERVE_READS_CAPABILITY,
			ENTRIES_TAIL_CAPABILITY,
			SET_PERMISSION_PRESET_CAPABILITY,
			// Host capabilities, not client opt-ins: only a multi-session host owns the
			// attachment refcount `open_session.retain_on_disconnect` detaches from, the
			// per-session launch profile `context`/`auto_title` travel on, and the session
			// listing `kind` filters.
			RETAIN_ON_DISCONNECT_CAPABILITY,
			// Only a multi-session host tracks attachments per connection, so only it can drop them on request.
			DETACH_CONNECTION_CAPABILITY,
			// Its host core decides every inbound line of a delegated connection before dispatch (senpi#5632).
			DELEGATED_CONNECTION_CAPABILITY,
			// ...and decides a host-mode connection's roles per incarnation, with receipts (omo-relay-daemon#307).
			DELEGATION_ROLES_CAPABILITY,
			// ...and may carry the forwarder-granted `peer_agent` role on such a connection (senpi#6305).
			PEER_AGENT_ROLE_CAPABILITY,
			// ...and lets the forwarder state a device is the host's own account, whose turns then ask nothing extra.
			SAME_ACCOUNT_DELEGATION_CAPABILITY,
			// Only a multi-session host keeps sessions loaded that a client can ask it to free.
			UNLOAD_SESSION_CAPABILITY,
			// Only a multi-session host owns a move ledger and the hosted-session list export checks against.
			MOVE_SESSION_CAPABILITY,
			MOVE_SESSION_REVOKE_CAPABILITY,
			MOVE_SESSION_COPY_CAPABILITY,
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
			// Each session's caller env lives on its own launch profile; the host process never holds it (senpi#4381).
			SESSION_ENV_CAPABILITY,
			// Each session's fallback chain is its own in-memory settings override, never the host's file.
			RETRY_FALLBACK_PROFILE_CAPABILITY,
			ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,
			AUTO_PERMISSION_PRESET_CAPABILITY,
			// Only an in-process runtime shares the loop a warm loads into (senpi#2314).
			...(options.warm ? [WARM_CAPABILITY] : []),
			...(options.parkClaim ? [PARK_CLAIM_CAPABILITY] : []),
			...toolRuntimeCapabilities(options.toolRuntime),
			// The host alone says where tool work runs; a negotiated copy would make two answers.
			...options.negotiated.filter(
				(capability) =>
					capability !== "mcp_form_presenter_v1" &&
					capability !== PARK_CLAIM_CAPABILITY &&
					// RULING-111 (LEAK-E): only the compact negotiation owns these names; flag off echoes them as main does.
					(!compactUpdatesEnabled() ||
						(capability !== "compact_message_updates_v1" && capability !== "compact_events")) &&
					!isHostOwnedToolRuntimeCapability(capability),
			),
		]),
	];
}
