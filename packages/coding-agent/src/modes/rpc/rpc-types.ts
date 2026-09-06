/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ThinkingSelection } from "@earendil-works/pi-ai";
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { PromptDisposition, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";
import type { ContextUsage } from "../../core/extensions/types.ts";
import type { SessionEntry, SessionTreeNode, UsageTotals } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { RpcSlashCommand } from "./rpc-command-surface.ts";

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

	// Fast mode (OpenAI Codex priority service tier)
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
	| {
			id?: string;
			type: "navigate_tree";
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string; themeName?: string }
	| { id?: string; type: "export_jsonl"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string; cwdOverride?: string }
	| { id?: string; type: "fork"; entryId: string; position?: "before" | "at" }
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
export const RPC_ERROR_MISSING_SESSION_ID = "missing_session_id";
export const RPC_ERROR_MULTI_SESSION_DISABLED = "multi_session_disabled";
export const RPC_ERROR_INVALID_PATH = "invalid_path";
export const RPC_ERROR_OPEN_FAILED = "open_failed";
export const RPC_ERROR_TOO_MANY_SESSIONS = "too_many_sessions";
export const RPC_ERROR_MEDIA_NOT_FOUND = "media_not_found";

export type RpcErrorCode =
	| typeof RPC_ERROR_UNKNOWN_SESSION
	| typeof RPC_ERROR_SESSION_CLOSING
	| typeof RPC_ERROR_SESSION_PATH_IN_USE
	| typeof RPC_ERROR_MISSING_SESSION_ID
	| typeof RPC_ERROR_MULTI_SESSION_DISABLED
	| typeof RPC_ERROR_INVALID_PATH
	| typeof RPC_ERROR_OPEN_FAILED
	| typeof RPC_ERROR_TOO_MANY_SESSIONS
	| typeof RPC_ERROR_MEDIA_NOT_FOUND;

/** Every established command accepts an additive routing envelope. */
export type RpcCommand =
	| (RpcSessionCommand & { sessionId?: string })
	| { id?: string; type: "get_protocol_info" }
	| {
			id?: string;
			type: "open_session";
			sessionPath?: string;
			cwd?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: ThinkingLevel;
			permissionPreset?: string;
	  }
	| { id?: string; type: "close_session"; sessionId: string }
	| { id?: string; type: "list_sessions" };

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
}

/** Account-slot metadata safe to send to desktop clients. */
export interface RpcProviderAccount {
	name: string;
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
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	| {
			id?: string;
			type: "response";
			command: "get_protocol_info";
			success: true;
			data: {
				protocolVersion: 1;
				serverVersion: string;
				capabilities: string[];
				mode: "classic" | "multi";
			};
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
			data: { cancelled: boolean; editorText?: string; aborted?: boolean; summaryEntry?: unknown };
	  }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "export_jsonl"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
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

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

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
	| {
			type: "extension_ui_request";
			id: string;
			method: "setHeader" | "setFooter";
			widgetLines: string[] | undefined;
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	// Additive (task 13/14): emitted ONLY when the client advertised the
	// "custom_unsupported" capability. ctx.ui.custom cannot render a third-party
	// component in RPC mode, so a flagged client gets this notice before custom()
	// returns undefined. Default clients never see it (byte-identical behavior).
	| { type: "extension_ui_request"; id: string; method: "custom_unsupported"; extensionName: string };

export type RpcExtensionEvent = {
	type: "extension_event";
	name: string;
	data: unknown;
};

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

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

/** Emitted after the loaded skill, extension, or MCP inventory changes. */
export interface RpcLoadedSurfacesChangedEvent {
	type: "loaded_surfaces_changed";
}

/** Emitted after an account is added, removed, pinned, or blocked by refresh failure. */
export interface RpcAuthAccountsChangedEvent {
	type: "auth_accounts_changed";
	provider: string;
}

/** Emitted when the SDK failover engine advances to a different account slot. */
export interface RpcAccountFailoverEvent {
	type: "account_failover";
	provider: string;
	from: string;
	to: string;
	reason: string;
}
