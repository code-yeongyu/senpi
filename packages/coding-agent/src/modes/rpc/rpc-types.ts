/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ProviderDiagnostic, ThinkingSelection } from "@earendil-works/pi-ai";
import type { SessionRuntimeKind } from "../../cli/args.ts";
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { PromptDisposition, QueuedInput, QueuedInputDisposition, SessionStats } from "../../core/agent-session.ts";
import type { SessionRetryFallbackProfile } from "../../core/agent-session-runtime.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { BrowserEngine } from "../../core/browser-engine.ts";
import type { ClientMessageIdentity } from "../../core/client-message-identity.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";
import type { EngineOrdinal } from "../../core/engine-build-identity.ts";
import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";
import type { ContextUsage, SessionControlAdmission, SessionKind } from "../../core/extensions/types.ts";
import type { ResolvedMessagePath } from "../../core/message-path-resolution.ts";
import type { SessionEntry, SessionMessageEntry, SessionTreeNode, UsageTotals } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { ApiKeyVerification } from "../../core/verify-api-key.ts";
import type { ClientMessageAdmission } from "./client-admission-record.ts";
import type { EffectState, EffectStatus } from "./effect-record.ts";
import type { RpcSlashCommand } from "./rpc-command-surface.ts";
import type { SessionStatusRecord } from "./session-status.ts";

export type { SessionContext, SessionKind } from "../../core/extensions/types.ts";
export type { RpcCommandInvocationEvent } from "./rpc-command-invocation.ts";
export type { RpcCommandsChangedEvent, RpcSlashCommand } from "./rpc-command-surface.ts";

import type { RpcSubscriptionLimitsEvent } from "./rpc-host-lifecycle-types.ts";

export type {
	RpcHostKernelMemory,
	RpcHostLifecycleEvent,
	RpcHostMemoryPressureEvent,
	RpcHostStalledEvent,
	RpcHostSupersededEvent,
	RpcHostTrimmedEvent,
	RpcSubscriptionLimitsEvent,
} from "./rpc-host-lifecycle-types.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

type RpcSessionCommand =
	// Prompting
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			thinkingLevel?: ThinkingLevel;
			sessionTitlePrompt?: string | false;
			expandPromptTemplates?: boolean;
			unknownCommandAsText?: boolean;
			clientMessageId?: string;
			clientTurnId?: string;
	  }
	| {
			id?: string;
			type: "send_custom_message";
			customType: string;
			content: unknown;
			display: boolean;
			details?: unknown;
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
	  }
	| { id?: string; type: "continue_from_leaf" }
	| { id?: string; type: "append_user_message"; content: unknown }
	| { id?: string; type: "append_session_entry"; entry: SessionEntry }
	| ({
			id?: string;
			type: "steer";
			message: string;
			images?: ImageContent[];
			enqueueOrder?: number;
			/** `"start"` starts a turn with this message when the session is idle (capability `steer_when_idle`). */
			whenIdle?: RpcWhenIdle;
	  } & ClientMessageIdentity)
	| ({
			id?: string;
			type: "follow_up";
			message: string;
			images?: ImageContent[];
			enqueueOrder?: number;
			/** `"start"` starts a turn with this message when the session is idle (capability `steer_when_idle`). */
			whenIdle?: RpcWhenIdle;
	  } & ClientMessageIdentity)
	/**
	 * `effectId` (1-256 chars, capability `effect_ledger`) records the abort as a durable effect BEFORE it is
	 * dispatched and makes a retry with the same id a replay; without it the abort behaves exactly as before.
	 */
	| {
			id?: string;
			type: "abort";
			effectId?: string;
			/** Answer only once the session is idle (or `graceMs` passed); the answer says which. */
			awaitIdle?: boolean;
			/** Drain the steering and follow-up queues atomically before the abort. */
			clearQueue?: boolean;
			/** How long `awaitIdle` waits, 0..60000 ms; default 10000. */
			graceMs?: number;
	  }
	| { id?: string; type: "interrupt"; turnId?: string }
	| { id?: string; type: "abort_compaction" }
	| { id?: string; type: "reload" }
	| { id?: string; type: "check_reload_veto" }
	| { id?: string; type: "clear_queue"; abortWillFollow?: boolean }
	/** Remove one queued input by its `queuedId` (from `get_state` / `queue_update`) before it reaches a turn. */
	| { id?: string; type: "dequeue_message"; queuedId: string; expectedRevision?: number; effectId?: string }
	/** Replace the text of one queued input in place, keeping its order and identity. */
	| {
			id?: string;
			type: "edit_queued_message";
			queuedId: string;
			text: string;
			expectedRevision?: number;
			effectId?: string;
	  }
	| { id?: string; type: "get_steering_messages" }
	| { id?: string; type: "get_follow_up_messages" }
	| { id?: string; type: "abort_branch_summary" }
	| { id?: string; type: "new_session"; parentSession?: string }
	/**
	 * Runs the session's inbox drain once and answers what it admitted - the same contract as a
	 * terminal control endpoint's `wake`. `delivery_ids` names the deliveries the caller just queued;
	 * a session whose extension registered no control endpoint answers `admitted: []`.
	 */
	| { id?: string; type: "wake"; delivery_ids?: string[] }

	// State
	| { id?: string; type: "get_state" }
	/**
	 * The newest receipt of one effect (capability `effect_ledger`). With `sessionId` it answers from the
	 * loaded session; with `sessionPath` (and no `sessionId`) from that transcript on disk, searching the
	 * whole file before answering `found: false`. For inputs `effectId` is the `clientMessageId`.
	 */
	| { id?: string; type: "get_effect_status"; effectId: string; sessionPath?: string }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string; effectId?: string }
	| { id?: string; type: "set_favorite_models"; models: RpcSessionModelEntry[] }
	| { id?: string; type: "set_scoped_models"; models: RpcSessionModelEntry[] }
	| { id?: string; type: "cycle_model"; direction?: "forward" | "backward" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel; scope?: "turn"; effectId?: string }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Fast mode (ChatGPT Subscription priority service tier)
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_fast_mode" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "set_retry_fallback"; retryFallback: SessionRetryFallbackProfile }

	// Bash
	| {
			id?: string;
			type: "bash";
			command: string;
			/** Identifies output chunks to the requesting client. */
			bashId?: string;
			excludeFromContext?: boolean;
			executionId?: string;
			operations?: Record<string, unknown>;
	  }
	| { id?: string; type: "record_bash_result"; command: string; result: BashResult; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "cleanup_bash_output"; path: string }
	| { id?: string; type: "set_label"; entryId: string; label?: string }
	| ({
			id?: string;
			type: "navigate_tree";
			/** Select for retry (default), or resume the exact entry as leaf with no editorText. */
			intent?: "select" | "resume";
			/** Leaf the client last observed; the navigation is refused with `stale_leaf` when the session moved on. */
			expectedLeafId?: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  } & (
			| {
					/**
					 * Entry to navigate to. Unless intent is `resume`, the host applies the `/tree`
					 * selection rule of `docs/sessions.md`: a user/custom target selects its PARENT and
					 * returns `editorText`; any other kind moves the leaf TO the entry with no `editorText`;
					 * the root user message resets the leaf to an empty conversation (`leafId: null`). A
					 * client therefore never computes a parent id. Answers `NavigateTreeResult`.
					 */
					entryId: string;
					targetId?: never;
			  }
			| {
					/**
					 * Original spelling, kept for the TUI and shipped clients. By default applies the selection
					 * rule as `entryId`: user/custom targets select their PARENT and return `editorText`,
					 * other targets select themselves, and a root user target yields `leafId: null`.
					 * Answers the legacy `{ cancelled, leafId, editorText? }` payload. New clients use `entryId`.
					 */
					targetId: string;
					entryId?: never;
			  }
	  ))

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "resolve_path"; path: string }
	| { id?: string; type: "memory_report" }
	| { id?: string; type: "export_html"; outputPath?: string; themeName?: string }
	| { id?: string; type: "export_jsonl"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string; cwdOverride?: string }
	| { id?: string; type: "fork"; entryId: string; position?: "before" | "at" }
	| {
			id?: string;
			type: "edit_assistant_message";
			entryId: string;
			text: string;
			/** Leaf the client last observed; the edit is refused with `stale_leaf` when the session moved on. */
			expectedLeafId?: string;
			summarize?: boolean;
			customInstructions?: string;
	  }
	| {
			id?: string;
			type: "edit_user_message";
			entryId: string;
			text: string;
			/** Leaf the client last observed; the edit is refused with `stale_leaf` when the session moved on. */
			expectedLeafId?: string;
			summarize?: boolean;
			customInstructions?: string;
	  }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string; limit?: number; maxBytes?: number }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "import_jsonl"; inputPath: string; cwdOverride?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	/**
	 * Fetch one media block a `media_placeholders` client received as an `image_ref`
	 * stub. `contentIndex` indexes the toolResult's `content` array and must point at
	 * an image block; anything else answers `media_not_found`.
	 */
	| { id?: string; type: "get_media"; toolCallId: string; contentIndex: number }

	// Commands and loaded runtime surfaces
	| { id?: string; type: "get_commands" }
	| { id?: string; type: "get_loaded_surfaces" }
	| { id?: string; type: "extension_request"; name: string; data?: unknown }
	| { id?: string; type: "eval_cells.list" }
	| { id?: string; type: "eval_cells.peek"; cellId: string; tailBytes?: number }
	| { id?: string; type: "eval_cells.stop"; cellId: string }

	// Auth (task 13) is additive. get_auth_providers, login_api_key and logout
	// answer synchronously. login_start responds immediately (flow-started) and
	// completion is delivered via auth_login_url / auth_login_end EVENTS, because
	// an interactive OAuth round-trip cannot fit the 30s request timeout.
	| { id?: string; type: "get_auth_providers" }
	| { id?: string; type: "login_start"; provider: string }
	| { id?: string; type: "login_cancel"; provider: string }
	| { id?: string; type: "login_api_key"; provider: string; key: string }
	| { id?: string; type: "logout"; provider: string }
	// Checks a key with the provider's model list without storing it (desktop #2510).
	| { id?: string; type: "verify_api_key"; provider: string; key: string }

	// Provider accounts (task 13) are additive. The desktop consumer contract
	// lives in ../omo-desktop-app/packages/contracts/src/rpc.ts and is updated separately.
	| { id?: string; type: "get_provider_accounts"; provider: string }
	| { id?: string; type: "account_pin"; provider: string; name: string | null }
	| { id?: string; type: "account_remove"; provider: string; name: string }
	| { id?: string; type: "account_order"; provider: string; names: string[] | null }
	| { id?: string; type: "set_client_info"; width: number; capabilities?: string[] };

/** Stable multi-session protocol error codes. */
export const RPC_ERROR_UNKNOWN_SESSION = "unknown_session";
/** `set_session_context` requires an attachment on the requesting connection. */
export const RPC_ERROR_SESSION_NOT_ATTACHED = "session_not_attached";
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
/** `release_session` while clients are attached, without `force: true`; `errorData.attachments` names how many. */
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

/** `abort` with `awaitIdle` or `clearQueue`: whether the turn stopped and what was cleared. */
export interface RpcAbortQuiesce {
	/** The aborted turn ended within `graceMs` (with `clearQueue` alone: no turn was running). */
	stopped: boolean;
	/** The session was idle when the answer was sent. Equal to `stopped` today; kept separate so a later
	 * host can report a stopped turn whose session immediately started queued work. */
	idle: boolean;
	/** Queued inputs `clearQueue` removed (0 when not requested). */
	cleared: number;
}

/** Capability: `steer`/`follow_up` accept `whenIdle: "start"`. */
export const STEER_WHEN_IDLE_CAPABILITY = "steer_when_idle";

/** What `steer`/`follow_up` do on an idle session: queue (default) or start a turn. */
export type RpcWhenIdle = "queue" | "start";

/** What `dequeue_message` / `edit_queued_message` did; anything but removed/edited carries reason + action. */
export interface RpcQueuedInputChange {
	queuedId: string;
	status: "removed" | "edited" | "already_delivered" | "not_found" | "conflict";
	/** `edited`: the text and revision the input now has. */
	text?: string;
	revision?: number;
	/** `conflict`: the input's revision, which `expectedRevision` did not match; nothing was changed. */
	currentRevision?: number;
	reason?: string;
	action?: string;
}

/** What an effect command (`abort`/`set_model`/`set_thinking_level` with `effectId`) answers about its receipt. */
export interface RpcEffectAnswer {
	effectId: string;
	state: EffectState;
	effect: EffectStatus;
	/** The id was seen before with the same request: nothing was performed again. */
	replayed?: true;
}

/** Every established command accepts an additive routing envelope. */
export type RpcCommand =
	| (RpcSessionCommand & { sessionId?: string })
	| {
			id?: string;
			type: "get_protocol_info";
			/** An observing read: this connection never counts as host activity (docs/rpc.md, idle exit). */
			observe?: boolean;
	  }
	| {
			id?: string;
			type: "open_session";
			/**
			 * Attach only to an existing session on this host generation. Requires
			 * `expected_host_instance`; mismatch returns `owner_changed`, a released
			 * session returns `session_not_held`. Neither refusal creates a writer.
			 */
			expectedHostInstance?: string;
			sessionPath?: string;
			cwd?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: ThinkingLevel;
			permissionPreset?: string;
			/**
			 * Keep this session alive when its last client disconnects (default false).
			 * The drop only releases that client's attachment: the session stays listed
			 * with `attachments: 0`, finishes its turn, and is re-attached by a later
			 * `open_session` for the same `sessionPath`. Requires the host capability
			 * `retain_on_disconnect`; older hosts ignore the field and close as before.
			 */
			retain_on_disconnect?: boolean;
			/**
			 * Visibility class of this session (default `interactive`). A `worker` session is
			 * machine-driven work: it is omitted from `list_sessions` unless the caller asks
			 * for workers, and its lifecycle records reach only connections attached to it.
			 * Requires the host capability `session_kind`.
			 */
			kind?: SessionKind;
			/**
			 * Opaque labels for this session, readable by its own extensions as
			 * `pi.sessionContext` and republished on `list_sessions { include_workers: true }`.
			 * At most 32 keys matching `^[a-z][a-z0-9_]*$`, each value at most 16 KiB, at most
			 * 32 KiB of JSON in total; anything else is refused with `invalid_session_context`.
			 * The host never interprets them. Requires the host capability `session_context`.
			 */
			context?: Record<string, string>;
			/**
			 * Whether THIS session auto-generates a title from its first prompt (default:
			 * the host's `--auto-title-sessions` / appMode decision). Requires the host
			 * capability `auto_title_per_session`. A non-boolean is refused with
			 * `invalid_launch_profile`.
			 */
			auto_title?: boolean;
			/**
			 * The durable session id to CREATE this session with, so a caller that already has a
			 * stable record id for the conversation keeps ONE identity instead of maintaining a
			 * mapping. Requires the host capability `durable_session_id`.
			 *
			 * Deliberately NOT named `sessionId`: the routing envelope above carries that name on
			 * every established command, and this value is not a routing handle.
			 *
			 * Applied ONLY when this open creates the session. When `sessionPath` names an existing
			 * session file, that file's header id stays authoritative and this field is ignored -
			 * a resume never rewrites identity. Refused with `invalid_session_id` when malformed and
			 * with `session_id_in_use` when a live session already holds it.
			 */
			durableSessionId?: string;
			/**
			 * Where THIS session's replies render (default: the host's `SENPI_PROMPT_SURFACE`). `app` builds
			 * a prompt with no visible routing line that keeps tool and hook feedback with the agent;
			 * `terminal` is the classic prompt; `chat` (a chat bridge) is `app` with no handoff block, ledger
			 * lines, or todo handoff cues, and needs `prompt_surface_chat`. A later open that attaches with
			 * another value rebuilds the session's prompt; an attach without it keeps the current surface.
			 * Requires the host capability `prompt_surface`. Any other value is refused with `invalid_launch_profile`.
			 */
			promptSurface?: PromptSurface;
			/**
			 * Which browser THIS session's skills drive: `connected` (the user's own browser), `builtin` (the
			 * app's in-app browser) or `none`. Session-scoped, never process-wide: the session's tool
			 * subprocesses and eval kernel see `OMO_BROWSER_ENGINE=<value>`, other sessions on the host do
			 * not, and a session opened without it sees no such variable. A later open that attaches with
			 * another value moves the live session to it; an attach without it keeps the current engine.
			 * Requires the host capability `browser_engine`. Any other value is refused with `invalid_launch_profile`.
			 */
			browserEngine?: BrowserEngine;
			/**
			 * The fallback policy THIS session runs with (e.g. a task child's own chain): applied as an
			 * in-memory override of this session's `retry.modelFallback` / `retry.fallbackChains`, never written
			 * to a settings file and never seen by another session. Requires the host capability
			 * `retry_fallback_profile`; a malformed value is refused with `invalid_launch_profile`. Applied
			 * when the open creates the session; an attach keeps the session's existing policy.
			 */
			retryFallback?: SessionRetryFallbackProfile;
	  }
	| { id?: string; type: "close_session"; sessionId: string }
	| {
			id?: string;
			/**
			 * Hands the session over to a runtime outside this host (`omo daemon adopt` resumes it in a local
			 * terminal with `--session <session_path>`): records `session_released` in the transcript, tears
			 * the session down without replaying anything, and frees its path reservation, so the next
			 * writer of the file is the one the caller starts. Refused with `turn_active` mid-turn unless
			 * `interrupt` (the turn is aborted first), and with `attached` while clients hold it unless
			 * `force` (they receive `session_closed { reason: "released" }`).
			 */
			type: "release_session";
			sessionId: string;
			reason: "takeover";
			interrupt?: boolean;
			force?: boolean;
	  }
	| {
			id?: string;
			/**
			 * Free a session this host keeps loaded: the transcript stays, queued input is kept for the reopen,
			 * and `session_parked { reason: "unloaded" }` reaches every attached client. Refused with a reason
			 * and an action while work runs (unless `interrupt`), while other clients are attached (unless
			 * `force`) or while child sessions it started are open here (unless `children: "detach"`).
			 */
			type: "unload_session";
			sessionId: string;
			effectId?: string;
			interrupt?: boolean;
			clearQueue?: boolean;
			children?: "refuse" | "detach";
			force?: boolean;
	  }
	| {
			id?: string;
			/**
			 * Meant as the connection's last request: release every session attachment it holds, then answer.
			 * Advertised as `detach_connection`. Closing the socket afterwards releases nothing more.
			 */
			type: "detach_connection";
	  }
	| {
			id?: string;
			/** Every subscription account's latest limit windows (senpi#3370); capability `subscription_limits`. */
			type: "get_subscription_limits";
			/** An observing read, as on `get_protocol_info`. */
			observe?: boolean;
	  }
	| {
			id?: string;
			type: "list_sessions";
			/**
			 * Include `kind: "worker"` rows, each with its `context` (default false). A
			 * default listing publishes interactive sessions only and carries no `context`.
			 */
			include_workers?: boolean;
			/** An observing read, as on `get_protocol_info`. */
			observe?: boolean;
	  }
	| {
			id?: string;
			/**
			 * Subscribe this connection to `session_status` records (docs/rpc.md, "Session status stream"). The
			 * answer carries a snapshot at `seq: 0`; every later record of the subscription is strictly +1.
			 * Activity-neutral: never an attachment, never refreshes a session's idle window. Requires the host
			 * capability `session_status`.
			 */
			type: "subscribe_sessions";
			/** `"all"` (default), routing/durable ids or paths, or the children of one durable session id. */
			sessions?: "all" | { ids: string[] } | { childrenOf: string };
			/** Include `kind: "worker"` sessions (default: true for `childrenOf`, false otherwise). */
			include_workers?: boolean;
			/** Carry each session's published `context` on its records (default false). */
			include_context?: boolean;
			/**
			 * Also deliver `effect_status` receipts of matched sessions, each emitted after the record that
			 * caused the transition (default: true for `childrenOf`, false otherwise).
			 */
			effects?: boolean;
			/** Also deliver these content record types of matched sessions (default `"none"`); opt-in, never an attachment. */
			mirror?: "none" | "all" | string[];
			/** Mark the request activity-neutral for the supervisor's idle exit, as on `list_sessions`. */
			observe?: boolean;
	  }
	| { id?: string; type: "unsubscribe_sessions"; subscriptionId: string; observe?: boolean }
	| {
			id?: string;
			/**
			 * Patch the context an attached session publishes (`list_sessions { include_workers: true }`, and
			 * `session_status` for subscribers with `include_context`). `null` deletes a key; host keys are
			 * refused with `invalid_session_context`. Requires the host capability `session_status`.
			 */
			type: "set_session_context";
			sessionId: string;
			patch: Record<string, string | number | boolean | null>;
	  }
	| {
			id?: string;
			type: "warm";
			/**
			 * Load what the next `open_session` with these inputs needs - the extension module graph and
			 * the runtimes its extensions load for this kind and context - WITHOUT opening a session
			 * (senpi#2314). Never listed, never an attachment, idempotent per profile. `cwd`, `kind` and
			 * `context` mean what they mean on `open_session`. Requires the host capability `warm`.
			 */
			cwd?: string;
			kind?: SessionKind;
			context?: Record<string, string>;
	  };

// ============================================================================
// Auth provider info (get_auth_providers response)
// ============================================================================

/** One provider row for the /login and /logout selectors. */
export interface RpcAuthProvider {
	/** Provider id (e.g. "anthropic", "openai"). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** How this provider authenticates. */
	authType: "oauth" | "api_key";
	/** Auth status without exposing or refreshing any credential. */
	status: RpcAuthStatus;
	/** Last four characters of an API key stored by the app; absent for OAuth, env, models.json and short keys. */
	keyHint?: string;
}

/** Auth status mirror (no credential values), from getProviderAuthStatus. */
export interface RpcAuthStatus {
	configured: boolean;
	source?:
		| "stored"
		| "runtime"
		| "environment"
		| "fallback"
		| "models_json_key"
		| "models_json_command"
		| "models_json_headers"
		| "extension_headers";
	label?: string;
	ambient?: true;
}

/** Account-slot metadata safe to send to desktop clients. */
export interface RpcProviderAccount {
	/** Immutable selector ID; render displayName (name) when metadata is present. */
	name: string;
	displayName?: string;
	source: "login" | "import" | "env";
	blocked: boolean;
	pinned: boolean;
}

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** One extension module loaded by the session resource loader. */
export interface RpcLoadedExtension {
	name: string;
	path: string;
	sourceInfo: SourceInfo;
	enabled: boolean;
}

export type RpcMcpServerStatus =
	| "enabled"
	| "disabled"
	| "untrusted"
	| "idle"
	| "connecting"
	| "connected"
	| "degraded"
	| "suspended"
	| "needs_auth"
	| "needs_client_registration";

/** Runtime MCP server state projected from the session-owned MCP service. */
export interface RpcLoadedMcpServer {
	name: string;
	toolCount: number;
	status: RpcMcpServerStatus;
	authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionModelEntry {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	thinkingSelection?: ThinkingSelection;
	serviceTier?: ServiceTier;
}

export interface RpcSessionState {
	model?: Model<any>;
	/**
	 * Model switch held until the next compaction, or `null` when no switch is held.
	 * This key is always present so clients can distinguish no hold from an older host.
	 */
	pendingModelSwitch: { provider: string; id: string } | null;
	thinkingLevel: ThinkingLevel;
	/**
	 * Explicit selector provenance for `thinkingLevel`, absent for SDK-defaulted
	 * effective levels. An attached client cannot distinguish "the user chose high"
	 * from "high is simply the effective level" without it.
	 */
	thinkingSelection?: ThinkingSelection;
	/**
	 * Abort owner of the most recent aborted turn, or the in-flight one while it is
	 * still settling. Retained after settle: the live session getter is transient, so a
	 * client that snapshots state after the turn ends would otherwise see nothing and
	 * fall back to generic wording instead of "Operation aborted".
	 */
	lastAbortSource?: AgentAbortSource;
	/**
	 * Structured provider failure family of the most recent failed assistant turn, when its
	 * provider adapter supplied one (same lifetime as the agent's `errorMessage`).
	 */
	lastProviderDiagnostic?: ProviderDiagnostic;
	/** Service tier the session resolved for the active model, if any. */
	serviceTier?: ServiceTier;
	/** True when the active model is served at the priority ("fast") tier. */
	fastMode: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	cwd: string;
	/** Whether project-scoped settings and resources are trusted by the host. */
	projectTrusted: boolean;
	/** Authoritative entries for setup-only sessions whose deferred file does not exist yet. */
	entries?: SessionEntry[];
	favoriteModels: RpcSessionModelEntry[];
	scopedModels: RpcSessionModelEntry[];
	steering: string[];
	followUp: string[];
	ordered: QueuedInput[];
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	usageTotals: UsageTotals;
	contextUsage?: ContextUsage;
	retryAttempt: number;
	isBashRunning: boolean;
	/** Open question prompts awaiting an answer. Absent when none are pending. */
	pendingQuestions?: RpcQuestionUiRequest[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

/**
 * What a host was launched with. `extensions` are absolute roots, deduplicated and
 * sorted, so two hosts that loaded the same set produce the same bytes regardless of
 * the order their launchers passed them.
 */
export interface RpcLaunchProfileCore {
	readonly extensions: readonly string[];
	readonly multi_session: boolean;
	readonly session_runtime: SessionRuntimeKind;
}

/** `profile_id` = sha256 of the canonical JSON of `core` (keys sorted); any client can recompute it. */
export interface RpcLaunchProfile {
	readonly profile_id: string;
	readonly core: RpcLaunchProfileCore;
}

/**
 * Host identity. Compatibility and upgrade decisions are made from these fields -
 * `protocolVersion`, `capabilities` and `engineOrdinal` - NEVER from `serverVersion`,
 * which is informational only.
 */
export interface RpcProtocolIdentity {
	/** UUID minted at host boot; it changes when the host process does, including on a handoff. */
	readonly instanceId: string;
	/** Generation of this host within its daemon directory; 0 when nobody ensured it. */
	readonly generation: number;
	/** Engine build text: the package version plus `+<buildEpoch>.<sha7>` when the build defined them. */
	readonly engineVersion: string;
	/** `[year, month, day, postRelease, buildEpoch]`, compared with `compareEngineOrdinal`. */
	readonly engineOrdinal: EngineOrdinal;
	readonly launch_profile: RpcLaunchProfile;
}

export interface RpcProtocolInfo extends RpcProtocolIdentity {
	/** Supervised socket hosts expose admission state independently of child responsiveness. */
	readonly lifecycle?: "ready" | "stopping";
	readonly protocolVersion: 1;
	/** Informational engine version. Never compare it for compatibility - use the fields above. */
	readonly serverVersion: string;
	readonly capabilities: string[];
	readonly mode: "classic" | "multi";
	/**
	 * Multi-session hosts only: whether this host's memory sampler currently reads its memory footprint above
	 * `SENPI_RPC_HOST_RSS_WARN_MB` (the state `host_memory_pressure` records announce). Observability only.
	 */
	readonly memory_pressure?: boolean;
}

// Success responses with data
export type RpcResponse =
	| {
			id?: string;
			type: "response";
			command: "get_protocol_info";
			success: true;
			data: RpcProtocolInfo;
	  }
	| {
			id?: string;
			type: "response";
			command: "open_session";
			success: true;
			data: { sessionId: string; state: RpcSessionState; attached?: boolean };
	  }
	| { id?: string; type: "response"; command: "close_session"; success: true; data: Record<string, never> }
	| {
			id?: string;
			type: "response";
			command: "unload_session";
			success: true;
			/** A refusal changes nothing and names why (`reason`, `detail`) and what to do (`action`). */
			data: RpcUnloadAnswer;
	  }
	| {
			id?: string;
			type: "response";
			command: "release_session";
			success: true;
			/**
			 * `attachments`: clients that were still attached (non-zero only with `force`). `dropped`: what an
			 * `interrupt` took out of the queues - delivery ids their sender must redeliver to the next owner,
			 * and the user's queued steer/follow-up text in enqueue order, for the adopting client to handle.
			 */
			data: {
				released: true;
				session_path: string;
				attachments: number;
				dropped: { deliveries: readonly string[]; user_messages: readonly string[] };
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "wake";
			success: true;
			data: { admitted: readonly SessionControlAdmission[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "warm";
			success: true;
			/** `unsupported`: this host's session runtime cannot be warmed from the host process (worker isolates). */
			data: { state: "warmed" | "already_warm" | "unsupported" };
	  }
	| {
			id?: string;
			type: "response";
			command: "detach_connection";
			success: true;
			/**
			 * Sessions that still count this connection: releasing it would end a turn still running (it
			 * releases when the turn settles), or the host is draining. Empty when every attachment is gone.
			 */
			data: { deferred: string[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subscription_limits";
			success: true;
			/** An account nothing has reported for is absent: unknown, never 0%. */
			data: { accounts: ReadonlyArray<Omit<RpcSubscriptionLimitsEvent, "type">> };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_sessions";
			success: true;
			data: {
				sessions: Array<{
					sessionId: string;
					durableSessionId?: string;
					sessionPath?: string;
					cwd: string;
					name?: string;
					status: "opening" | "open" | "closing" | "closed";
					/** Live client attachments; `0` is a retained session with no client attached. */
					attachments: number;
					/** Milliseconds since the session's idle window was last refreshed. */
					idleMs?: number;
				}>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "subscribe_sessions";
			success: true;
			data: {
				subscriptionId: string;
				snapshot: readonly SessionStatusRecord[];
				seq: number;
				hostGeneration: string;
				hostInstanceId: string;
			};
	  }
	| { id?: string; type: "response"; command: "unsubscribe_sessions"; success: true }
	| {
			id?: string;
			type: "response";
			command: "set_session_context";
			success: true;
			data: { context: Readonly<Record<string, string | number | boolean>> };
	  }
	// Prompting (async - events follow)
	// data.disposition reports how the host disposed the prompt (started/queued/handled)
	// so proxied optimistic-echo contracts resolve exactly like the local path; older
	// hosts omit it and clients must degrade to canonical-only rendering. steer/follow_up carry the
	// per-input disposition (queued/handled) under the same optional contract.
	| {
			id?: string;
			type: "response";
			command: "prompt";
			success: true;
			data?: ClientMessageIdentity & { disposition?: PromptDisposition; admission?: ClientMessageAdmission };
	  }
	| { id?: string; type: "response"; command: "send_custom_message"; success: true }
	| { id?: string; type: "response"; command: "append_user_message"; success: true }
	| { id?: string; type: "response"; command: "append_session_entry"; success: true }
	| {
			id?: string;
			type: "response";
			command: "steer";
			success: true;
			data?: ClientMessageIdentity & { disposition?: QueuedInputDisposition; admission?: ClientMessageAdmission };
	  }
	| {
			id?: string;
			type: "response";
			command: "follow_up";
			success: true;
			data?: ClientMessageIdentity & { disposition?: QueuedInputDisposition; admission?: ClientMessageAdmission };
	  }
	| {
			id?: string;
			type: "response";
			command: "abort";
			success: true;
			data?: RpcEffectAnswer | (Partial<RpcEffectAnswer> & RpcAbortQuiesce);
	  }
	| {
			id?: string;
			type: "response";
			command: "dequeue_message" | "edit_queued_message";
			success: true;
			data: RpcQueuedInputChange & Partial<RpcEffectAnswer>;
	  }
	| {
			id?: string;
			type: "response";
			command: "interrupt";
			success: true;
			data: { interrupted: boolean; turnId?: string };
	  }
	| { id?: string; type: "response"; command: "abort_compaction"; success: true }
	| { id?: string; type: "response"; command: "reload"; success: true; data: { cancelled: boolean; reason?: string } }
	| {
			id?: string;
			type: "response";
			command: "check_reload_veto";
			success: true;
			data: { cancelled: boolean; reason?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "clear_queue";
			success: true;
			data: {
				steering: string[];
				followUp: string[];
				ordered: QueuedInput[];
			};
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			/** With `effectId`: the effect fields beside the model, or only them on a replay. */
			data: (Model<any> & { systemPromptName?: string } & Partial<RpcEffectAnswer>) | RpcEffectAnswer;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_effect_status";
			success: true;
			data: { found: true; effect: EffectStatus } | { found: false; searched: "complete" };
	  }
	| { id?: string; type: "response"; command: "set_favorite_models"; success: true }
	| { id?: string; type: "response"; command: "set_scoped_models"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| { id?: string; type: "response"; command: "continue_from_leaf"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: {
				models: Array<Model<any> & { supportedThinkingLevels: ThinkingLevel[]; supportsAssistantPrefill: boolean }>;
			};
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true; data?: RpcEffectAnswer }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Fast mode
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; serviceTier: ServiceTier; provider: string; modelId: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_fast_mode";
			success: true;
			data: { enabled: boolean; serviceTier: ServiceTier | null };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }
	| { id?: string; type: "response"; command: "set_retry_fallback"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| {
			id?: string;
			type: "response";
			command: "navigate_tree";
			success: true;
			/**
			 * `NavigateTreeResult` answers an `entryId` navigation; the shipped shape answers a
			 * `targetId` one. Both report `leafId` - the leaf the session was left on, `null` for an
			 * empty conversation - so a client resynchronizes in one round trip on either spelling.
			 */
			data:
				| NavigateTreeResult
				| {
						cancelled: boolean;
						leafId: string | null;
						editorText?: string;
						aborted?: boolean;
						summaryEntry?: unknown;
				  };
	  }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "resolve_path"; success: true; data: ResolvedMessagePath }
	| {
			id?: string;
			type: "response";
			command: "memory_report";
			success: true;
			data: { path: string; heapSnapshot?: string };
	  }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "export_jsonl"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "edit_assistant_message";
			success: true;
			data: EditAssistantMessageResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "edit_user_message";
			success: true;
			data: EditUserMessageResult;
	  }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null; hasMore?: boolean; nextSince?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "import_jsonl"; success: true; data: { cancelled: boolean } }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| {
			id?: string;
			type: "response";
			command: "get_media";
			success: true;
			data: { toolCallId: string; contentIndex: number; content: ImageContent };
	  }

	// Commands and loaded runtime surfaces
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_loaded_surfaces";
			success: true;
			data: { extensions: RpcLoadedExtension[]; mcpServers: RpcLoadedMcpServer[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "extension_request";
			success: true;
			data: unknown;
	  }
	| { id?: string; type: "response"; command: "eval_cells.list"; success: true; data: RpcEvalCell[] }
	| {
			id?: string;
			type: "response";
			command: "eval_cells.peek" | "eval_cells.stop";
			success: true;
			data: RpcEvalCellSnapshot;
	  }

	// Auth (task 13)
	| {
			id?: string;
			type: "response";
			command: "get_auth_providers";
			success: true;
			data: { providers: RpcAuthProvider[] };
	  }
	// login_start returns immediately: success:true means the flow has started.
	// The URL and completion arrive as auth_login_url / auth_login_end events.
	| { id?: string; type: "response"; command: "login_start"; success: true }
	| { id?: string; type: "response"; command: "login_cancel"; success: true }
	| { id?: string; type: "response"; command: "login_api_key"; success: true }
	| { id?: string; type: "response"; command: "logout"; success: true }
	| {
			id?: string;
			type: "response";
			command: "verify_api_key";
			success: true;
			data: ApiKeyVerification;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_provider_accounts";
			success: true;
			data: { accounts: RpcProviderAccount[]; ordered: boolean };
	  }
	| { id?: string; type: "response"; command: "account_pin"; success: true }
	| { id?: string; type: "response"; command: "account_remove"; success: true }
	| { id?: string; type: "response"; command: "account_order"; success: true }

	// Error response (any command can fail)
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			errorCode?: string;
			errorData?: unknown;
	  };

/** Session-owned cell metadata; live and recently settled cells share the same list shape. */
export interface RpcEvalCell {
	readonly cellId: string;
	readonly language: "js" | "py" | "rb" | "jl";
	readonly state: "queued" | "running" | "detached" | "completed" | "failed" | "cancelled";
	readonly startedAtMs: number;
	readonly summary?: string;
	readonly queuedBehind?: readonly string[];
}

/** Bounded text-only snapshot: no duplicated result body, code, or inline images. */
export interface RpcEvalCellSnapshot extends RpcEvalCell {
	readonly outputTail: string;
	readonly stateRetained?: boolean;
	readonly interruptNote?: string;
	readonly hardLimitSeconds?: number;
	readonly runBudgetSeconds?: number;
}

/** Success payload of `edit_assistant_message`. `leafId` is the session leaf after the call. */
export type EditAssistantMessageResult =
	| { outcome: "edited"; entry: SessionMessageEntry; leafId: string; summaryEntryId?: string }
	| { outcome: "unchanged"; leafId: string | null }
	| { outcome: "cancelled"; leafId: string | null; aborted?: boolean };

/**
 * Success payload of `edit_user_message`, mirroring `EditAssistantMessageResult`. `leafId` is the
 * session leaf after the call and is reported on EVERY outcome so a client resynchronizes in one
 * round trip; it is `null` when the call left the session on an empty conversation.
 */
export type EditUserMessageResult =
	| { outcome: "edited"; entry: SessionMessageEntry; leafId: string; summaryEntryId?: string }
	| { outcome: "unchanged"; leafId: string | null }
	| { outcome: "cancelled"; leafId: string | null; aborted?: boolean };

/**
 * Success payload of an `entryId`-addressed `navigate_tree`. `editorText` is present when the
 * intent is selection and the target is a user/custom message, as in the TUI editor. Resumption
 * never returns editor text. `leafId` is `null` when selection reset the session to an empty
 * conversation, which is what selecting the root user message does.
 */
export type NavigateTreeResult =
	| { outcome: "navigated"; leafId: string | null; editorText?: string; summaryEntryId?: string }
	| { outcome: "cancelled"; leafId: string | null; aborted?: boolean };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** One question in an RPC `question` UI request. Matches canonical QuestionRequest.questions. */
export type RpcQuestionSpec = {
	id: string;
	header: string;
	question: string;
	options: Array<{ label: string; description?: string }>;
	multiSelect: boolean;
};

export type RpcQuestionAnswers = Record<string, { selected: string[]; text?: string }>;

export type RpcQuestionOutcome =
	| "answered"
	| "comment-submitted"
	| "timed_out"
	| "cancelled"
	| "orphaned-after-restart"
	| "unavailable";

/** Outbound `extension_ui_request` body for method `question`. */
export type RpcQuestionUiRequest = {
	type: "extension_ui_request";
	id: string;
	method: "question";
	requestId: string;
	toolCallId: string;
	waitForAnswer: boolean;
	questions: RpcQuestionSpec[];
	timeout: number;
	askedAtMs: number;
	deadlineAtMs: number;
	remainingMs: number;
};

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			timeout?: number;
			/** The tool call this dialog approves, when it is a permission request. */
			toolCallId?: string;
			parentToolCallId?: string;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
			toolCallId?: string;
			parentToolCallId?: string;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	// Additive (task 13/14): emitted ONLY when the client advertised the
	// "custom_unsupported" capability. ctx.ui.custom cannot render a third-party
	// component in RPC mode, so a flagged client gets this notice before custom()
	// returns undefined. Default clients never see it (byte-identical behavior).
	| { type: "extension_ui_request"; id: string; method: "custom_unsupported"; extensionName: string }
	| RpcQuestionUiRequest;

export type RpcExtensionEvent = {
	type: "extension_event";
	name: string;
	data: unknown;
};

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/**
 * Response to an extension UI request. `id` is this frame's correlation id, echoed by its reply;
 * `uiRequestId` names the request answered, and without it `id` does (the short form).
 */
type RpcExtensionUIResponseFrame = { type: "extension_ui_response"; id: string; uiRequestId?: string };
export type RpcExtensionUIResponse =
	| (RpcExtensionUIResponseFrame & { value: string })
	| (RpcExtensionUIResponseFrame & { confirmed: boolean })
	| (RpcExtensionUIResponseFrame & { cancelled: true })
	| (RpcExtensionUIResponseFrame & { answers: RpcQuestionAnswers; comment?: string });

/** Inbound draft updates for an open `question` request. */
export type RpcExtensionUIProgress = {
	type: "extension_ui_progress";
	id: string;
	answers?: RpcQuestionAnswers;
	comment?: string;
	sessionId?: string;
};

/** Stdin records: session/host commands plus extension-UI replies and progress. */
export type RpcInboundRecord = RpcCommand | RpcExtensionUIResponse | RpcExtensionUIProgress;

/** Outbound deadline refresh for an open `question` request. */
export type RpcQuestionUpdatedEvent = {
	type: "question_updated";
	id: string;
	deadlineAtMs: number;
	remainingMs: number;
};

/** Outbound terminal outcome for a `question` request. */
export type RpcQuestionResolvedEvent = {
	type: "question_resolved";
	resolvedBy?: "local_ui" | "rpc_connection" | "control_endpoint";
	id: string;
	requestId: string;
	toolCallId: string;
	outcome: RpcQuestionOutcome;
	answers: RpcQuestionAnswers;
	comment?: string;
	unanswered: string[];
	deadlineAtMs?: number;
};

/** Emitted when the effective session thinking level changes. */
export interface RpcThinkingLevelChangedEvent {
	type: "thinking_level_changed";
	level: ThinkingLevel;
	/**
	 * Selector provenance in force after the change; absent when the level is an
	 * SDK-defaulted effective level rather than an explicit choice. Additive: an old
	 * client that does not know the field ignores it.
	 */
	thinkingSelection?: ThinkingSelection;
}

export interface RpcHighReasoningWarningEvent {
	type: "high_reasoning_warning";
	modelId: string;
	provider: string;
	thinkingLevel: ThinkingLevel;
}

/** Emitted after explicit skill tokens are expanded for a user-authored request. */
export interface RpcSkillInvocationEvent {
	type: "skill_invocation";
	skills: readonly {
		name: string;
		path: string;
		syntax: "dollar" | "slash";
	}[];
}

/** Emitted when startup or reload selects an existing settings file. */
export interface RpcSettingsSourceSelectedEvent {
	type: "settings_source_selected";
	path: string;
	format: "jsonc" | "json";
	reason: "explicit-jsonc" | "json-only";
	scope: "global" | "project";
}

/**
 * Emitted after the session's active model changed, with the thinking level in force AFTER
 * the switch (per-model memory, a favorite's pinned level, or the clamped previous level).
 *
 * Clients that tracked the model by inferring it from `entry_appended` can consume this
 * instead. Additive: an old client that does not know the type filters it out.
 */
export interface RpcModelChangedEvent {
	type: "model_changed";
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Why the model changed: "set", "cycle", "restore", "fallback", or "fallback-revert". */
	source: string;
	/** Selector provenance for `thinkingLevel` after the switch, when one was explicit. */
	thinkingSelection?: ThinkingSelection;
}

/** Emitted when the effective service tier or fast-mode state of the session changes. */
export interface RpcServiceTierChangedEvent {
	type: "service_tier_changed";
	tier?: ServiceTier;
	fastMode: boolean;
}
/**
 * Emitted after the host swapped the live session behind this connection (new session,
 * fork, or switch), carrying the new authoritative identity.
 *
 * A replacement can be initiated by ANY attached client. Without this event the other
 * attached clients keep their stale identity and keep routing replacement-dependent
 * actions at the session that no longer exists. Additive: an old client that does not
 * know the type filters it out.
 */
export interface RpcSessionReplacedEvent {
	type: "session_replaced";
	/**
	 * Durable session id of the session now bound to this connection.
	 *
	 * Deliberately NOT `sessionId`: top-level `sessionId` is reserved for the
	 * per-connection routing handle that multi-session hosts tag every record
	 * with, and that tag is applied last - it would overwrite this value and
	 * leave the event carrying no identity at all.
	 */
	durableSessionId: string;
	/** Session file backing the new session, absent for a deferred setup-only session. */
	sessionFile?: string;
	cwd: string;
	sessionName?: string;
}

/** What `unload_session` answers. `effect` is the ledger receipt when the command carried an `effectId`. */
export interface RpcUnloadAnswer {
	outcome: "unloaded" | "refused";
	sessionPath?: string;
	reason?: UnloadRefusalReason;
	detail?: string;
	action?: string;
	effectId?: string;
	effect?: EffectStatus;
	replayed?: boolean;
}

export type UnloadRefusalReason =
	| "turn_active"
	| "work_pending"
	| "extension_work"
	| "children_live"
	| "attached"
	| "host_draining"
	| "unsupported"
	| "session_closing";

/**
 * Emitted when a shared host PARKS a session instead of closing it: the idle window
 * elapsed for a session opened with `retain_on_disconnect`, so the host released the
 * routing handle while the session itself stays on disk.
 *
 * It replaces `session_closed` for that handle - a parked session was not ended, and
 * `open_session { sessionPath }` reopens it (as a NEW routing handle). Additive: a
 * client that does not know the type filters it out and learns the handle is gone
 * from its next command's `unknown_session`.
 */
export type RpcSessionParkedEvent = {
	type: "session_parked";
	/** Routing handle that was released; it never resolves again. */
	sessionId: string;
	/** Session file to reopen this session by. */
	sessionPath: string;
	/** `idle`: the idle sweep parked it; `unloaded`: `unload_session` did. Absent from older hosts. */
	reason?: "idle" | "unloaded";
};

/**
 * Why a `session_closed` record was emitted, when the host names a reason.
 *
 * Optional on the wire and open to new members: a client that does not recognise a reason, or
 * receives a record with no `reason` field, treats it exactly as it treated a reason-less one.
 * Never required in decoders.
 *
 * - `client_close`: an attached client sent `close_session`.
 * - `idle_evicted`: the idle sweep ended a session that was not retained.
 * - `host_shutdown`: the host process is exiting (SIGTERM / idle-exit / empty-host).
 * - `replaced`: the live session behind this handle was swapped (`session_replaced` is the
 *   in-place identity event; this reason is for a handle that ended because of a replacement).
 * - `handoff_parked`: a generation handoff drained this host and put the session back on disk.
 *   The session was not ended - `open_session { sessionPath }` reopens it in the new generation.
 * - `session_dir_removed`: the session's transcript directory was deleted, so it could never persist
 *   again. The idle sweep ends it once no client holds it; a handoff drain ends it instead of parking
 *   it with a path nothing can reopen (senpi#2285).
 * - `error`: the session failed (worker death, output overflow) and the host sealed it.
 * - `released`: `release_session` handed the session to a runtime outside this host. `sessionPath` is
 *   the file that runtime now writes: do NOT reopen it on this host, which would make a second writer.
 */
export type RpcSessionClosedReason =
	| "client_close"
	| "idle_evicted"
	| "host_shutdown"
	| "replaced"
	| "handoff_parked"
	| "session_dir_removed"
	| "released"
	| "error";

/** Terminal record of a closed routing handle. `reason` is absent on older hosts and older records. */
export type RpcSessionClosedEvent = {
	type: "session_closed";
	sessionId: string;
	reason?: RpcSessionClosedReason;
	/** File released by handoff parking; reopen it on the successor. */
	sessionPath?: string;
};

/**
 * First lifecycle record of a session this host created. Interactive sessions broadcast it; a worker's
 * reaches its attached connections and `subscribe_sessions` subscribers with `include_workers`.
 * `context` is present only for subscribers that asked for it (`include_context`).
 */
export interface RpcSessionOpenedEvent {
	type: "session_opened";
	sessionId: string;
	durableSessionId?: string;
	sessionPath?: string;
	kind: SessionKind;
	cwd: string;
	context?: Readonly<Record<string, string | number | boolean>>;
}

export type { SessionEffectStatusRecord as RpcEffectStatusEvent } from "./session-effect-status.ts";
export type { SessionStatusRecord as RpcSessionStatusEvent } from "./session-status.ts";

/**
 * Emitted after the loaded skill, extension, or MCP inventory changes. A multi-session host sends ONE per
 * connection per inventory digest, tagged with the first session that reported it.
 */
export interface RpcLoadedSurfacesChangedEvent {
	type: "loaded_surfaces_changed";
}

/** Emitted after an account is added, removed, pinned, or blocked by refresh failure. */
export interface RpcAuthAccountsChangedEvent {
	type: "auth_accounts_changed";
	provider: string;
}

/**
 * Sent to ONE opener the moment its `open_session` is accepted, before the open enters the
 * session loop. The in-process host serves opens one at a time, so a burst queues; without this
 * the client's only signal is a deadline it cannot explain (senpi#1844). A multi-session host sends
 * the same record for a session-routed `prompt` the moment it is received, before its preflight runs
 * on the session's loop, so a client waits out a slow preflight instead of discarding the session at
 * its plain request deadline (senpi#2871).
 *
 * `for_request` carries the opener's request id deliberately, NOT the response-id field: a client
 * settles pending requests by response id, and a queued record wearing the open's id would be
 * taken as the open's reply.
 */
export interface RpcOpenQueuedEvent {
	type: "queued";
	/** The `open_session` or `prompt` request this position belongs to. */
	for_request: string;
	/** 1-based place in the open queue at acceptance; for a `prompt`, its place among that session's requests in flight. */
	position: number;
	/** Opens (for a `prompt`, that session's requests) already in flight when this one arrived; `position` is this plus one. */
	in_flight: number;
}

/** Emitted when the SDK failover engine advances to a different account slot. */
export interface RpcAccountFailoverEvent {
	type: "account_failover";
	provider: string;
	from: string;
	to: string;
	reason: string;
}
