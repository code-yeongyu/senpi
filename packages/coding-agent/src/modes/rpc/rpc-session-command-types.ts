import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

import type { SessionRetryFallbackProfile } from "../../core/agent-session-runtime.ts";
import type { BashResult } from "../../core/bash-executor.ts";

import type { ClientMessageIdentity } from "../../core/client-message-identity.ts";

import type { SessionEntry } from "../../core/session-manager.ts";
import type { ToolBarrierSpec } from "../../core/tool-barrier.ts";

import type { RpcSessionModelEntry } from "./rpc-session-state-types.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcSessionCommand =
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
			/** Arm the tool barrier for the turn this prompt starts (capability `tool_barrier`, senpi#3717). */
			toolBarrier?: ToolBarrierSpec;
	  }
	/** Open the tool barrier armed under `barrierId`; an unknown or cleared id is a successful no-op. */
	| { id?: string; type: "release_tool_barrier"; barrierId: string }
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
	/** Resume after a Stop or an unattended hold. Every field is optional so older clients keep working (senpi#3811). */
	| {
			id?: string;
			type: "resume_session";
			expectedSeq?: number;
			mode?: "continue" | "release";
			message?: string;
			effectId?: string;
	  }
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
			/** `stop` is a user Stop: the session is paused until human input or resume_session (senpi#3811). */
			intent?: "stop" | "abort";
	  }
	| { id?: string; type: "interrupt"; turnId?: string; intent?: "stop" | "abort" }
	/** Human input held for a paused session, delivered when it resumes; idempotent by inputId (senpi#3811). */
	| {
			id?: string;
			type: "hold_input";
			inputId: string;
			revision: number;
			text: string;
			/** Required from a task_parent connection: the parent session that paused this child for its run. */
			parentSessionId?: string;
			origin?: "human";
	  }
	| { id?: string; type: "withdraw_held_input"; inputId: string }
	/** Task-parent connections only: pause or resume this child for its parent's run (senpi#3811). */
	| {
			id?: string;
			type: "pause_for_run";
			parentSessionId: string;
			parentPauseSeq: number;
			runRef: { kind: "dag" | "task" | "workpool" | "team"; id: string };
	  }
	| {
			id?: string;
			type: "resume_for_run";
			parentSessionId: string;
			parentPauseSeq: number;
			resumeId: string;
			childSeqCutoff: number;
	  }
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
	| { id?: string; type: "get_snapshot"; tail?: number; maxBytes?: number; observe?: boolean }
	| { id?: string; type: "request_self_settle" }
	/**
	 * The newest receipt of one effect (capability `effect_ledger`). With `sessionId` it answers from the
	 * loaded session; with `sessionPath` (and no `sessionId`) from that transcript on disk, searching the
	 * whole file before answering `found: false`. For inputs `effectId` is the `clientMessageId`.
	 */
	| { id?: string; type: "get_effect_status"; effectId: string; sessionPath?: string }
	/**
	 * The pending inputs in durable custody (queued, sending, failed) and an explicit outcome for each listed id,
	 * consistent through `throughCursor` (senpi#3549). Subscribe to `pending_input_update` first, then apply this
	 * snapshot and only updates after its cursor. At most 64 ids.
	 */
	| { id?: string; type: "get_pending_inputs"; knownClientMessageIds?: string[] }

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
	| { id?: string; type: "get_model_thinking_level"; provider: string; modelId: string }

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
	/**
	 * `since`/`before` bound the range (strictly after / strictly before an entry id); `limit` pages it forward from
	 * its start, `tail` backward from its end (`next_before` names the next page, senpi#4267).
	 */
	| {
			id?: string;
			type: "get_entries";
			since?: string;
			before?: string;
			limit?: number;
			tail?: number;
			maxBytes?: number;
	  }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	/** The user started typing a draft in this session's composer (senpi#3859). Only `draft` is accepted. */
	| { id?: string; type: "record_user_activity"; kind: "draft" }
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

/** What `steer`/`follow_up` do on an idle session: queue (default) or start a turn. */
export type RpcWhenIdle = "queue" | "start";

/** Capability: `steer`/`follow_up` accept `whenIdle: "start"`. */
export const STEER_WHEN_IDLE_CAPABILITY = "steer_when_idle";

/** Capability: `record_user_activity` reports composer draft activity (senpi#3859). */
export const USER_ACTIVITY_CAPABILITY = "user_activity";
