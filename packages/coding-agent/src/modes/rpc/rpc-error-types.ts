/** Stable multi-session protocol error codes. */
export const RPC_ERROR_UNKNOWN_SESSION = "unknown_session";

/** `set_session_context` requires an attachment on the requesting connection. */
export const RPC_ERROR_SESSION_NOT_ATTACHED = "session_not_attached";
export const RPC_ERROR_SESSION_IDENTITY_MISMATCH = "session_identity_mismatch";
export const RPC_ERROR_SESSION_BUSY_LIFECYCLE = "session_busy_lifecycle";
export const RPC_ERROR_ATTACHED_ELSEWHERE = "attached_elsewhere";

export const RPC_ERROR_SESSION_CLOSING = "session_closing";

export const RPC_ERROR_SESSION_PATH_IN_USE = "session_path_in_use";

/** A live process outside this host holds the session JSONL; retry after it exits. */
export const RPC_ERROR_SESSION_HELD = "session_held";

export const RPC_ERROR_SESSION_RESERVATION_LIMIT = "session_reservation_limit";

export const RPC_ERROR_MISSING_SESSION_ID = "missing_session_id";

export const RPC_ERROR_MULTI_SESSION_DISABLED = "multi_session_disabled";

export const RPC_ERROR_INVALID_PATH = "invalid_path";

/** A command field outside its documented range; `errorData` carries `reason` and `action`. */
export const RPC_ERROR_INVALID_ARGUMENT = "invalid_argument";

/** An answer would pass the per-response byte budget; read the history in pages (`get_entries` `limit`/`maxBytes`). */
export const RPC_ERROR_RESPONSE_TOO_LARGE = "response_too_large";

export const RPC_ERROR_OPEN_FAILED = "open_failed";

export const RPC_ERROR_OWNER_CHANGED = "owner_changed";

export const RPC_ERROR_SESSION_NOT_HELD = "session_not_held";

export const RPC_ERROR_MEDIA_NOT_FOUND = "media_not_found";

/** `open_session.context` broke a documented cap (key count, key syntax, value or total bytes). */
export const RPC_ERROR_INVALID_SESSION_CONTEXT = "invalid_session_context";

/** `open_session.env` is malformed or names a variable that is not caller-passable on this host (senpi#4381). */
export const RPC_ERROR_INVALID_SESSION_ENV = "invalid_session_env";

/** `subscribe_sessions` named a malformed selector, mirror or flag; `errorData { reason, action }` says what to send. */
export const RPC_ERROR_INVALID_SUBSCRIPTION = "invalid_subscription";

/** `unsubscribe_sessions` named a subscription this connection does not hold. */
export const RPC_ERROR_UNKNOWN_SUBSCRIPTION = "unknown_subscription";

/** `subscribe_sessions` on a connection that already holds the documented maximum number of subscriptions. */
export const RPC_ERROR_SUBSCRIPTION_LIMIT = "subscription_limit";

/** `subscribe_sessions`/`unsubscribe_sessions` on a transport with no per-connection identity (stdio). */
export const RPC_ERROR_UNSUPPORTED_TRANSPORT = "unsupported_transport";

/** `open_session.kind` was neither `interactive` nor `worker`; an unknown kind is never downgraded. */
export const RPC_ERROR_INVALID_SESSION_KIND = "invalid_session_kind";

/** A launch-profile field on `open_session` (currently `auto_title`) was the wrong type. */
export const RPC_ERROR_INVALID_LAUNCH_PROFILE = "invalid_launch_profile";

/** `open_session.durableSessionId` was not a legal session id (see `assertValidSessionId`). */
export const RPC_ERROR_INVALID_SESSION_ID = "invalid_session_id";

/**
 * `open_session.durableSessionId` is already held by a LIVE session. Two live sessions may
 * never share one durable id: every per-session artifact a client keys by that id (goal files,
 * subagent and team attribution) would collide. Close the holder, or open with a different id.
 */
export const RPC_ERROR_SESSION_ID_IN_USE = "session_id_in_use";

/**
 * Sent only by hosts released before senpi#2207, which declined NEW worker sessions above an RSS
 * watermark with `errorData { rssMb, retry_after_ms }`. Current hosts never refuse an open for
 * memory; clients keep recognizing the code while older generations may still answer.
 */
export const RPC_ERROR_HOST_MEMORY_PRESSURE = "host_memory_pressure";

/** `warm` could not load the profile it was asked for (missing cwd, an extension that failed to load). */
export const RPC_ERROR_WARM_FAILED = "warm_failed";

// Message-edit and tree-navigation failures (mirror AssistantEditError.code / UserEditError.code /
// SessionStreamingError.code). Every code lives in the one shared RpcErrorCode union below: the
// failure response is a single catch-all member, so a command's codes are a documented SUBSET
// rather than a per-command type.
export const RPC_ERROR_STREAMING = "streaming";

export const RPC_ERROR_ENTRY_NOT_FOUND = "not_found";

/** `set_model` named a provider/model pair the session's registry does not offer. */
export const RPC_ERROR_MODEL_NOT_FOUND = "model_not_found";

/** An `effectId` was reused for a different request; `errorData` carries `reason` and `action`. */
export const RPC_ERROR_EFFECT_ID_CONFLICT = "effect_id_conflict";

/** `get_effect_status { sessionPath }` could not read the transcript; this is never a `found: false`. */
export const RPC_ERROR_TRANSCRIPT_UNREADABLE = "transcript_unreadable";

/** `set_model { effectId }` was refused because the model's provider cannot serve it now. */
export const RPC_ERROR_PROVIDER_UNAVAILABLE = "provider_unavailable";

// `prompt` refusals before a turn starts (mirror ModelNotReadyError.code); the two provider codes carry
// `errorData { provider }`.
export const RPC_ERROR_PROVIDER_CREDENTIALS_MISSING = "provider_credentials_missing";
export const RPC_ERROR_PROVIDER_CREDENTIALS_EXPIRED = "provider_credentials_expired";
export const RPC_ERROR_NO_MODEL_SELECTED = "no_model_selected";

/** `set_model { effectId }` was refused because the target cannot hold the session context. */
export const RPC_ERROR_CONTEXT_BUDGET = "context_budget";

export const RPC_ERROR_EVAL_CELL_NOT_FOUND = "eval_cell_not_found";

export const RPC_ERROR_INVALID_EVAL_CELL_REQUEST = "invalid_eval_cell_request";

export const RPC_ERROR_EVAL_CELLS_UNAVAILABLE = "eval_cells_unavailable";

export const RPC_ERROR_NOT_ASSISTANT = "not_assistant";

export const RPC_ERROR_NOT_USER = "not_user";

export const RPC_ERROR_EMPTY_TEXT = "empty";

export const RPC_ERROR_STALE_LEAF = "stale_leaf";

/** `prompt` text was command-shaped but no command handles it; mirrors `UnknownCommandError`. */
export const RPC_ERROR_UNKNOWN_COMMAND = "unknown_command";

/**
 * `release_session` while a turn runs or is about to start (a prompt in preflight, an admitted delivery
 * not yet written), without `interrupt: true`; `errorData.busy` names the signals.
 */
export const RPC_ERROR_TURN_ACTIVE = "turn_active";

/** `release_session` while other session work runs (bash, compaction, another request for the session); `errorData.busy` names it. */
export const RPC_ERROR_SESSION_BUSY = "session_busy";

/** `release_session` while OTHER clients are attached (the requesting connection does not count), without `force`; `errorData.attachments` names how many. */
export const RPC_ERROR_ATTACHED = "attached";

/** `release_session` with a `reason` other than `takeover`. */
export const RPC_ERROR_INVALID_RELEASE_REASON = "invalid_release_reason";

/** `release_session` for a session this host cannot hand over: `errorData.detail` is `worker_runtime` or `no_session_file`. */
export const RPC_ERROR_RELEASE_UNSUPPORTED = "release_unsupported";

/**
 * `release_session` whose hand-over failed after it began (writing the `session_released` entry or the
 * teardown threw): `errorData.detail` is the error message, plus `interrupted`/`dropped` after an interrupt.
 * When the entry could not be written the session stays on this host, admission open and no entry left in
 * memory; a teardown that fails after it claimed the session leaves it closing.
 */
export const RPC_ERROR_RELEASE_FAILED = "release_failed";

/** A draining host parks every session itself; `release_session` and `open_session` are refused meanwhile. */
export const RPC_ERROR_HOST_DRAINING = "host_draining";

/** The supervisor has closed admission; a launch-owning caller may ensure a successor. */
export const RPC_ERROR_HOST_STOPPING = "host_stopping";

export type RpcErrorCode =
	| typeof RPC_ERROR_SESSION_IDENTITY_MISMATCH
	| typeof RPC_ERROR_SESSION_BUSY_LIFECYCLE
	| typeof RPC_ERROR_ATTACHED_ELSEWHERE
	| typeof RPC_ERROR_OWNER_CHANGED
	| typeof RPC_ERROR_SESSION_NOT_HELD
	| typeof RPC_ERROR_HOST_STOPPING
	| typeof RPC_ERROR_UNKNOWN_SESSION
	| typeof RPC_ERROR_SESSION_NOT_ATTACHED
	| typeof RPC_ERROR_SESSION_CLOSING
	| typeof RPC_ERROR_SESSION_PATH_IN_USE
	| typeof RPC_ERROR_SESSION_HELD
	| typeof RPC_ERROR_SESSION_RESERVATION_LIMIT
	| typeof RPC_ERROR_MISSING_SESSION_ID
	| typeof RPC_ERROR_MULTI_SESSION_DISABLED
	| typeof RPC_ERROR_INVALID_PATH
	| typeof RPC_ERROR_OPEN_FAILED
	| typeof RPC_ERROR_MEDIA_NOT_FOUND
	| typeof RPC_ERROR_INVALID_SESSION_CONTEXT
	| typeof RPC_ERROR_INVALID_SUBSCRIPTION
	| typeof RPC_ERROR_UNKNOWN_SUBSCRIPTION
	| typeof RPC_ERROR_SUBSCRIPTION_LIMIT
	| typeof RPC_ERROR_UNSUPPORTED_TRANSPORT
	| typeof RPC_ERROR_INVALID_SESSION_KIND
	| typeof RPC_ERROR_INVALID_LAUNCH_PROFILE
	| typeof RPC_ERROR_INVALID_SESSION_ID
	| typeof RPC_ERROR_SESSION_ID_IN_USE
	| typeof RPC_ERROR_HOST_MEMORY_PRESSURE
	| typeof RPC_ERROR_WARM_FAILED
	| typeof RPC_ERROR_STREAMING
	| typeof RPC_ERROR_ENTRY_NOT_FOUND
	| typeof RPC_ERROR_MODEL_NOT_FOUND
	| typeof RPC_ERROR_EFFECT_ID_CONFLICT
	| typeof RPC_ERROR_TRANSCRIPT_UNREADABLE
	| typeof RPC_ERROR_PROVIDER_UNAVAILABLE
	| typeof RPC_ERROR_PROVIDER_CREDENTIALS_MISSING
	| typeof RPC_ERROR_PROVIDER_CREDENTIALS_EXPIRED
	| typeof RPC_ERROR_NO_MODEL_SELECTED
	| typeof RPC_ERROR_CONTEXT_BUDGET
	| typeof RPC_ERROR_EVAL_CELL_NOT_FOUND
	| typeof RPC_ERROR_INVALID_EVAL_CELL_REQUEST
	| typeof RPC_ERROR_EVAL_CELLS_UNAVAILABLE
	| typeof RPC_ERROR_NOT_ASSISTANT
	| typeof RPC_ERROR_NOT_USER
	| typeof RPC_ERROR_EMPTY_TEXT
	| typeof RPC_ERROR_UNKNOWN_COMMAND
	| typeof RPC_ERROR_STALE_LEAF
	| typeof RPC_ERROR_TURN_ACTIVE
	| typeof RPC_ERROR_SESSION_BUSY
	| typeof RPC_ERROR_ATTACHED
	| typeof RPC_ERROR_INVALID_RELEASE_REASON
	| typeof RPC_ERROR_RELEASE_UNSUPPORTED
	| typeof RPC_ERROR_RELEASE_FAILED
	| typeof RPC_ERROR_HOST_DRAINING;
