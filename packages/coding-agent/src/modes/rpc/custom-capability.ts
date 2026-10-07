/**
 * The `custom_unsupported` capability gate (plan tasks 13/14).
 *
 * In RPC mode `ctx.ui.custom` cannot render a third-party component — there is no
 * TUI to render it FROM. Historically it returned `undefined` synchronously with
 * NO wire message, so a default RPC client saw nothing at all. A client that
 * can present a native "this extension UI requires the classic TUI" notice opts
 * in via a capability flag.
 *
 * This gate is a PURE function so the additive-only guarantee is unit-provable:
 * only a client that advertised the `custom_unsupported` capability gets the
 * additive `extension_ui_request{method:"custom_unsupported"}` notice; every
 * other (default) client gets `undefined` — byte-identical to the prior
 * behavior, no extra bytes on the wire.
 */

import * as crypto from "node:crypto";
import type { RpcExtensionUIRequest } from "./rpc-types.ts";

/** The capability string a client sends in its handshake to opt into the notice. */
export const CUSTOM_UNSUPPORTED_CAPABILITY = "custom_unsupported";
export const EXTENSION_EVENTS_CAPABILITY = "extension_events";
export const AUTO_TITLE_SESSIONS_CAPABILITY = "auto_title_sessions";
/** Host capability: the `continue_from_leaf` command starts a turn with no new prompt (#1930). */
export const CONTINUE_FROM_LEAF_CAPABILITY = "continue_from_leaf";
/**
 * Opt-in: the host replaces inline image bytes inside tool results with `image_ref`
 * placeholders for this connection; the client fetches a block on demand with `get_media`.
 */
export const MEDIA_PLACEHOLDERS_CAPABILITY = "media_placeholders";
/** Opt-in: the client can present a multi-question `extension_ui_request{method:"question"}`. */
export const QUESTION_CAPABILITY = "question";

/**
 * HOST capability (advertised in `get_protocol_info`, never sent by a client):
 * this host honors `open_session.retain_on_disconnect`, so a session opened with
 * that flag survives its last client's disconnect instead of being closed with it.
 */
export const RETAIN_ON_DISCONNECT_CAPABILITY = "retain_on_disconnect";

/**
 * HOST capability: this host accepts `open_session.context`, hands it to that session's
 * extensions as `pi.sessionContext`, and republishes it on `list_sessions { include_workers: true }`.
 */
export const SESSION_CONTEXT_CAPABILITY = "session_context";

/**
 * HOST capability: this host accepts `open_session.kind`, publishes `kind` on every
 * `list_sessions` row, hides `worker` rows unless `include_workers` is set, and keeps a
 * worker session's lifecycle records on the connections attached to it.
 */
export const SESSION_KIND_CAPABILITY = "session_kind";

/**
 * HOST capability: this host honors `open_session.auto_title`, so a session can opt
 * into or out of engine-side titling independently of `--auto-title-sessions`.
 */
export const AUTO_TITLE_PER_SESSION_CAPABILITY = "auto_title_per_session";

/**
 * HOST capability: this host answers `warm` (senpi#2314) - it loads what the next `open_session` for a
 * cwd, kind and context needs without opening a session. Advertised only by an in-process runtime.
 */
export const WARM_CAPABILITY = "warm";

/**
 * HOST capability: this host honors `open_session.durableSessionId`, so a caller that already
 * owns a stable record id for the conversation can CREATE the session under that id and keep
 * one identity instead of maintaining a mapping. Ignored on resume, where the session file's
 * header id stays authoritative.
 */
export const DURABLE_SESSION_ID_CAPABILITY = "durable_session_id";

/**
 * HOST capability: this host honors `open_session.promptSurface`, building each session's prompt for
 * the surface its opener renders on (`terminal` | `app`) instead of only the process-wide
 * `SENPI_PROMPT_SURFACE`. A later open that names another surface rebuilds that session's prompt.
 */
export const PROMPT_SURFACE_CAPABILITY = "prompt_surface";

/**
 * HOST capability: this host honors `open_session.browserEngine` (`connected` | `builtin` | `none`). The
 * choice is per session, never per process: that session's tool subprocesses and eval kernel see
 * `OMO_BROWSER_ENGINE=<value>` and no other session on the host does. Advertised only because the
 * value reaches every consumer, so a client may rely on it the moment it sees this name.
 */
export const BROWSER_ENGINE_CAPABILITY = "browser_engine";

/**
 * HOST capability: this host honors `open_session.retryFallback` (`{ modelFallback, fallbackChains }`). The
 * policy is that session's own: it is applied as an in-memory settings override for that session only,
 * never written to a settings file and never seen by another session on the host.
 */
export const RETRY_FALLBACK_PROFILE_CAPABILITY = "retry_fallback_profile";

/**
 * SINGLE-SESSION capability: this `--mode rpc` process accepts `set_retry_fallback` (the
 * `open_session.retryFallback` shape) before its first turn, so a caller that spawns one process per
 * session can give it its own fallback chain without a settings file.
 */
export const RETRY_FALLBACK_COMMAND_CAPABILITY = "retry_fallback_command";

/**
 * HOST capability: `open_session.promptSurface` also accepts `chat` (a chat bridge: no routing line,
 * no handoff block, no todo cues). A host without it refuses `chat` with `invalid_launch_profile`,
 * so a gateway sends `chat` only after seeing this and otherwise falls back to `app`.
 */
export const PROMPT_SURFACE_CHAT_CAPABILITY = "prompt_surface_chat";

/**
 * Env var carrying client capabilities to a single-connection stdio RPC host
 * (comma-separated). A launcher may set it from a client handshake; a plain
 * stdio client leaves it unset and sees byte-identical default behavior.
 */
export const RPC_CLIENT_CAPABILITIES_ENV = "SENPI_RPC_CLIENT_CAPABILITIES";

/** Parse the comma-separated capabilities env value into a trimmed list. */
export function parseClientCapabilities(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Fallback label when the calling extension's name cannot be determined. */
export const DEFAULT_CUSTOM_EXTENSION_LABEL = "custom UI component";

/**
 * Build the additive `custom_unsupported` request for a `ctx.ui.custom` call, or
 * `undefined` when the client did not opt in.
 *
 * Returning `undefined` is the load-bearing default-client path: the caller must
 * emit NOTHING in that case, preserving the exact prior wire behavior.
 */
export function buildCustomUnsupportedRequest(
	capabilities: readonly string[] | undefined,
	extensionName: string,
): RpcExtensionUIRequest | undefined {
	if (!capabilities?.includes(CUSTOM_UNSUPPORTED_CAPABILITY)) {
		return undefined;
	}
	const name = extensionName.trim() || DEFAULT_CUSTOM_EXTENSION_LABEL;
	return {
		type: "extension_ui_request",
		id: crypto.randomUUID(),
		method: "custom_unsupported",
		extensionName: name,
	};
}
