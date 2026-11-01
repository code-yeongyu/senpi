import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ProviderDiagnostic, ThinkingSelection } from "@earendil-works/pi-ai";

import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { QueuedInput } from "../../core/agent-session.ts";
import type { HoldKind } from "../../core/engine-turn-hold.ts";
import type { ProviderOrigin } from "../../core/provider-origin.ts";

import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";
import type { ContextUsage } from "../../core/extensions/types.ts";

import type { SessionEntry, UsageTotals } from "../../core/session-manager.ts";
import type { ThinkingLevelSource } from "../../core/session-thinking-memory.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { RpcSessionLifecycle } from "./lifecycle-delivery.ts";
import type { RpcExtensionUIRequest, RpcQuestionUiRequest } from "./rpc-question-types.ts";
import type { UiAnswerReceipt } from "./ui-answer-ledger.ts";

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
	/** Where the provider is defined, so a client can name the file or extension to edit (senpi#4328). */
	origin?: ProviderOrigin;
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
	/** Present only while `blocked`: `auth_error` = key rejected, skip it until `blockedUntil` (senpi#4327). */
	blockedReason?: "auth_error" | "rate_limit" | "disabled";
	/** Epoch ms when the block lifts; absent for `disabled` and for a block that names no time. */
	blockedUntil?: number;
	pinned: boolean;
	/** `claude-cli`: signed in through the bundled Claude Code CLI, whose own store holds the login (senpi#4436). */
	store?: "claude-cli";
	/** Epoch ms of the account's last sign-in. */
	signedInAt?: number;
	/** Profile `claude auth status` reported; local only, never logged. */
	email?: string;
	orgName?: string;
	subscriptionType?: string;
	/** The sign-in connection test's last result. */
	check?: { model: string; outcome: "ok" | "failed"; reason?: string; at: number };
	/** `needs_sign_in`: the account must sign in again before it is used. */
	signIn?: "signed_in" | "needs_sign_in";
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
	lastError?: string;
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
	/** Latest 64 UI-answer receipts in this session generation, oldest first. */
	answeredUiRequests?: UiAnswerReceipt[];
	paused: boolean;
	pausedNoticeCount: number;
	holds: { kind: HoldKind; key: string; since: string; data?: unknown; sourceCounts: Record<string, number> }[];
	lifecycle: RpcSessionLifecycle;
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
	 * Where `thinkingLevel` came from (senpi#3819): a direct request, this session's or the global
	 * last level for the model, a default, a fallback, or a clamp. Absent on older hosts.
	 */
	thinkingLevelSource?: ThinkingLevelSource;
	/**
	 * This session's last thinking level per model, keyed `provider/id` (senpi#3819). A model switch
	 * restores from it, so clients read it instead of keeping a copy. Absent on older hosts.
	 */
	sessionModelThinkingLevels?: Record<string, ThinkingLevel>;
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
	/** Human input held for delivery when the session resumes (senpi#3811). */
	pausedHeldInputCount?: number;
	/** A run this session started is paused by its Stop (senpi#3811). */
	runPaused?: boolean;
	/** The pause seq to send as `resume_session.expectedSeq`, and the live hold records (senpi#3811). */
	pause?: {
		pauseSeq: number;
		records: { kind: string; key: string; runRef?: { kind: string; id: string }; parentSessionId?: string }[];
	};
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
	/** Live select, confirm, input and editor request frames, including across session replacements; [] when none. */
	pendingDialogs?: RpcExtensionUIRequest[];
}
