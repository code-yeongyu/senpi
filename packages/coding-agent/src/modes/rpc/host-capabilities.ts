import {
	ACCEPT_EDITS_PERMISSION_PRESET_CAPABILITY,
	AUTO_PERMISSION_PRESET_CAPABILITY,
} from "../../core/extensions/builtin/permission-system/config.ts";
import { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from "./client-admission-record.ts";
import {
	AUTO_TITLE_PER_SESSION_CAPABILITY,
	AUTO_TITLE_SESSIONS_CAPABILITY,
	BROWSER_ENGINE_CAPABILITY,
	CONTINUE_FROM_LEAF_CAPABILITY,
	DURABLE_SESSION_ID_CAPABILITY,
	MEDIA_PLACEHOLDERS_CAPABILITY,
	MOVED_PATH_GUARD_CAPABILITY,
	PROMPT_SURFACE_CAPABILITY,
	PROMPT_SURFACE_CHAT_CAPABILITY,
	RETAIN_ON_DISCONNECT_CAPABILITY,
	RETRY_FALLBACK_PROFILE_CAPABILITY,
	SESSION_CONTEXT_CAPABILITY,
	SESSION_HELD_CAPABILITY,
	SESSION_KIND_CAPABILITY,
	WARM_CAPABILITY,
} from "./custom-capability.ts";

/**
 * The capabilities a multi-session host advertises in `get_protocol_info`, in their wire order. `warm` is added only
 * when the runtime is in-process, and `negotiated` carries the launch capabilities this connection was given.
 */
export function multiSessionHostCapabilities(options: {
	readonly warm: boolean;
	readonly negotiated: readonly string[];
}): string[] {
	return [
		...new Set([
			"multi_session",
			AUTO_TITLE_SESSIONS_CAPABILITY,
			MEDIA_PLACEHOLDERS_CAPABILITY,
			DURABLE_CLIENT_MESSAGE_ID_CAPABILITY,
			CONTINUE_FROM_LEAF_CAPABILITY,
			// Both shared runtimes dispatch through the active session-writing holder guard.
			SESSION_HELD_CAPABILITY,
			// Host capabilities, not client opt-ins: only a multi-session host owns the
			// attachment refcount `open_session.retain_on_disconnect` detaches from, the
			// per-session launch profile `context`/`auto_title` travel on, and the session
			// listing `kind` filters.
			RETAIN_ON_DISCONNECT_CAPABILITY,
			SESSION_CONTEXT_CAPABILITY,
			SESSION_KIND_CAPABILITY,
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
			...options.negotiated,
		]),
	];
}
