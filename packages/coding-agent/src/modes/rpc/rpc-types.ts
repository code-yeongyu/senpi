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
import type { PromptDisposition, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { CredentialAccountSummary } from "../../core/credential-accounts.ts";
import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";
import type { EngineOrdinal } from "../../core/engine-build-identity.ts";
import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";
import type { ContextUsage, SessionControlAdmission, SessionKind } from "../../core/extensions/types.ts";
import type { ProcessFootprintMeasure } from "../../core/process-footprint.ts";
import type { SessionEntry, SessionMessageEntry, SessionTreeNode, UsageTotals } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { RpcSlashCommand } from "./rpc-command-surface.ts";

export type { SessionContext, SessionKind } from "../../core/extensions/types.ts";
export type { RpcCommandInvocationEvent } from "./rpc-command-invocation.ts";
export type { RpcCommandsChangedEvent, RpcSlashCommand } from "./rpc-command-surface.ts";

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
	| { id?: string; type: "append_user_message"; content: unknown }
	| { id?: string; type: "append_session_entry"; entry: SessionEntry }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[]; enqueueOrder?: number }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[]; enqueueOrder?: number }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_compaction" }
	| { id?: string; type: "reload" }
	| { id?: string; type: "check_reload_veto" }
	| { id?: string; type: "clear_queue"; abortWillFollow?: boolean }
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

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "set_favorite_models"; models: RpcSessionModelEntry[] }
	| { id?: string; type: "set_scoped_models"; models: RpcSessionModelEntry[] }
	| { id?: string; type: "cycle_model"; direction?: "forward" | "backward" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel; scope?: "turn" }
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
	| { id?: string; type: "get_entries"; since?: string }
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

	// Auth (task 13) is additive. get_auth_providers, login_api_key and logout
	// answer synchronously. login_start responds immediately (flow-started) and
	// completion is delivered via auth_login_url / auth_login_end EVENTS, because
	// an interactive OAuth round-trip cannot fit the 30s request timeout.
	| { id?: string; type: "get_auth_providers" }
	| { id?: string; type: "login_start"; provider: string }
	| { id?: string; type: "login_cancel"; provider: string }
	| { id?: string; type: "login_api_key"; provider: string; key: string }
	| { id?: string; type: "logout"; provider: string }

	// Provider accounts (task 13) are additive. The desktop consumer contract
	// lives in ../omo-desktop-app/packages/contracts/src/rpc.ts and is updated separately.
	| { id?: string; type: "get_provider_accounts"; provider: string }
	| { id?: string; type: "account_pin"; provider: string; name: string | null }
	| { id?: string; type: "account_remove"; provider: string; name: string }
	| { id?: string; type: "set_client_info"; width: number; capabilities?: string[] };

/** Stable multi-session protocol error codes. */
export const RPC_ERROR_UNKNOWN_SESSION = "unknown_session";
export const RPC_ERROR_SESSION_CLOSING = "session_closing";
export const RPC_ERROR_SESSION_PATH_IN_USE = "session_path_in_use";
export const RPC_ERROR_SESSION_RESERVATION_LIMIT = "session_reservation_limit";
export const RPC_ERROR_MISSING_SESSION_ID = "missing_session_id";
export const RPC_ERROR_MULTI_SESSION_DISABLED = "multi_session_disabled";
export const RPC_ERROR_INVALID_PATH = "invalid_path";
export const RPC_ERROR_OPEN_FAILED = "open_failed";
export const RPC_ERROR_MEDIA_NOT_FOUND = "media_not_found";
/** `open_session.context` broke a documented cap (key count, key syntax, value or total bytes). */
export const RPC_ERROR_INVALID_SESSION_CONTEXT = "invalid_session_context";
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

export type RpcErrorCode =
	| typeof RPC_ERROR_UNKNOWN_SESSION
	| typeof RPC_ERROR_SESSION_CLOSING
	| typeof RPC_ERROR_SESSION_PATH_IN_USE
	| typeof RPC_ERROR_SESSION_RESERVATION_LIMIT
	| typeof RPC_ERROR_MISSING_SESSION_ID
	| typeof RPC_ERROR_MULTI_SESSION_DISABLED
	| typeof RPC_ERROR_INVALID_PATH
	| typeof RPC_ERROR_OPEN_FAILED
	| typeof RPC_ERROR_MEDIA_NOT_FOUND
	| typeof RPC_ERROR_INVALID_SESSION_CONTEXT
	| typeof RPC_ERROR_INVALID_SESSION_KIND
	| typeof RPC_ERROR_INVALID_LAUNCH_PROFILE
	| typeof RPC_ERROR_INVALID_SESSION_ID
	| typeof RPC_ERROR_SESSION_ID_IN_USE
	| typeof RPC_ERROR_HOST_MEMORY_PRESSURE
	| typeof RPC_ERROR_WARM_FAILED
	| typeof RPC_ERROR_STREAMING
	| typeof RPC_ERROR_ENTRY_NOT_FOUND
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
export type RpcProviderAccount = CredentialAccountSummary;

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
	ordered: Array<{ text: string; mode: "steer" | "followUp"; enqueueOrder: number }>;
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
				}>;
			};
	  }
	// Prompting (async - events follow)
	// data.disposition reports how the host disposed the prompt (started/queued/handled)
	// so proxied optimistic-echo contracts resolve exactly like the local path; older
	// hosts omit it and clients must degrade to canonical-only rendering.
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { disposition?: PromptDisposition } }
	| { id?: string; type: "response"; command: "send_custom_message"; success: true }
	| { id?: string; type: "response"; command: "append_user_message"; success: true }
	| { id?: string; type: "response"; command: "append_session_entry"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
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
				ordered: Array<{ text: string; mode: "steer" | "followUp"; enqueueOrder: number }>;
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
			data: Model<any> & { systemPromptName?: string };
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
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Array<Model<any> & { supportedThinkingLevels: ThinkingLevel[] }> };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
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
			data: { entries: SessionEntry[]; leafId: string | null };
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
			command: "get_provider_accounts";
			success: true;
			data: { accounts: RpcProviderAccount[] };
	  }
	| { id?: string; type: "response"; command: "account_pin"; success: true }
	| { id?: string; type: "response"; command: "account_remove"; success: true }

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
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
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

/** Sent once to every connection before this generation starts parking for a handoff. */
export interface RpcHostSupersededEvent {
	type: "host_superseded";
	instanceId: string;
	generation: number;
	/** Public endpoint of the successor, or null for a drain without a known successor. */
	successor: { socket: string } | null;
}

export type RpcHostLifecycleEvent = RpcHostSupersededEvent | RpcHostStalledEvent | RpcHostMemoryPressureEvent;

/** Emitted after the loaded skill, extension, or MCP inventory changes. */
export interface RpcLoadedSurfacesChangedEvent {
	type: "loaded_surfaces_changed";
}

/** Emitted after an account is added, removed, pinned, or blocked by refresh failure. */
export interface RpcAuthAccountsChangedEvent {
	type: "auth_accounts_changed";
	provider: string;
}

/**
 * Emitted when the host's event loop was blocked long enough to stall every session it
 * serves, naming the routing handle and tool whose work held it when that can be
 * attributed. Informational: the host never aborts or refuses anything because of it.
 */
/**
 * Sent to ONE opener the moment its `open_session` is accepted, before the open enters the
 * session loop. The in-process host serves opens one at a time, so a burst queues; without this
 * the client's only signal is a deadline it cannot explain (senpi#1844).
 *
 * `for_request` carries the opener's request id deliberately, NOT the response-id field: a client
 * settles pending requests by response id, and a queued record wearing the open's id would be
 * taken as the open's reply.
 */
export interface RpcOpenQueuedEvent {
	type: "queued";
	/** The `open_session` request this position belongs to. */
	for_request: string;
	/** 1-based place in the open queue at the moment of acceptance. */
	position: number;
	/** Opens already in flight when this one arrived; `position` is this plus one. */
	in_flight: number;
}

export interface RpcHostStalledEvent {
	type: "host_stalled";
	/** How late the host's own 200ms timer was invoked, i.e. how long the loop was held. */
	driftMs: number;
	/** Routing handle blamed for the stall, absent when no session work was running. */
	sessionId?: string;
	/** Tool that session was executing, when the stall happened inside one. */
	tool?: string;
	/**
	 * Process CPU time spent during the stalled window, in milliseconds. Near `driftMs`: the host
	 * was busy (JS work or a collection). Near zero: the process did not run (starved or waiting).
	 */
	processCpuMs?: number;
	/** JS heap change across the stalled window, in megabytes; a large drop means a collection ran. */
	heapDeltaMb?: number;
}

/**
 * Emitted while the host process's memory footprint is above its warning threshold. Capacity is memory,
 * never a refusal: the host reports the pressure and parks idle sessions sooner, and
 * never declines or kills a session because of it.
 */
export interface RpcHostMemoryPressureEvent {
	type: "host_memory_pressure";
	/** Resident set size of the host process, in megabytes (what `ps` shows; it stays high after memory is returned). */
	rssMb: number;
	/**
	 * Memory footprint of the host process, in megabytes: the number compared with the threshold (senpi#2261).
	 * Hosts released before it omit this and `measure`.
	 */
	footprintMb?: number;
	/** Kernel counter behind `footprintMb`; `"rss"` when the platform exposes no footprint counter. */
	measure?: ProcessFootprintMeasure;
	/** Live sessions the host is holding, including ones opening or closing. */
	sessions: number;
}

/** Emitted when the SDK failover engine advances to a different account slot. */
export interface RpcAccountFailoverEvent {
	type: "account_failover";
	provider: string;
	from: string;
	to: string;
	reason: string;
}
