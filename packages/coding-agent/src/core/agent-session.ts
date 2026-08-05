/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentContinuationOptions,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	PreparedAgentToolCall,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { prepareAgentToolCall } from "@earendil-works/pi-agent-core";
import { contentText, SERVER_FALLBACK_ABORTED_DIAGNOSTIC } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	cleanupSessionResources,
	isClassifierRefusal,
	isContextOverflow,
	isProviderStreamStallError,
	isProviderTimeoutError,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { extract429RetryAfterMs, parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import { getAgentDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { CompactionLifecycleCoordinator, type CompactionLifecycleState } from "./compaction/lifecycle.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "./dynamic-prompt/index.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import type { ServiceTier } from "./extensions/builtin/service-tier.ts";
import {
	type ContextUsage,
	ExecuteToolError,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionToolHookLifecycleEvent,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type SystemPromptChangeEvent,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type {
	ApplyCompactionOptions,
	ApplyCompactionResult,
	CompactionReason,
	CompactionRejectionCause,
	LazyToolActivator,
	ModelSelectSource,
} from "./extensions/types.ts";
import { RUNTIME_EXTENSION_PATH } from "./extensions/types.ts";
import { shouldWarnHighReasoning } from "./high-reasoning-warning.ts";
import { type BashExecutionMessage, type CustomMessage, filterContextExcludedMessages } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { type AvailableModelsSource, getModelNarrowingPatterns, resolveModelScope } from "./model-resolver.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { PROMPT_CACHE_SAFE_WAIT_ENV, resolvePromptCacheSafeWaitSeconds } from "./prompt-cache-budget.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { createProviderTimeoutRetryPlan, runBoundedRetryContinuation } from "./provider-timeout-retry.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { isBillingErrorMessage } from "./retry-fallback/billing.ts";
import { formatSelector } from "./retry-fallback/chains.ts";
import { RetryFallbackController } from "./retry-fallback/controller.ts";
import { SelectorCooldowns } from "./retry-fallback/cooldown.ts";
import {
	classifyRateLimitedWait,
	nextInTurnDelayMs,
	type ProbePhase,
	probeBackSchedule,
} from "./retry-fallback/hint-policy.ts";
import { createFallbackLogger } from "./retry-fallback/log.ts";
import { ProbeBackScheduler } from "./retry-fallback/probe-scheduler.ts";
import { validateFallbackChains } from "./retry-fallback/validate.ts";
import { createSessionLogger, type SessionLogger } from "./session-log.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import {
	buildSessionContext,
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	type SessionHeader,
} from "./session-manager.ts";
import { generateSessionTitle, sessionTitleRetryPolicy, shouldSkipSessionTitle } from "./session-title-generator.ts";
import { SessionWorkBarrier } from "./session-work-barrier.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { getSupportedThinkingLevels, supportsMax, supportsXhigh } from "./thinking-levels.ts";
import { resetTimings, time } from "./timings.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

const TURN_RETRY_SUPPRESSION_PREFIX = "senpi:no-turn-retry:";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
type AgentSessionAgentEndEvent = Extract<AgentEvent, { type: "agent_end" }> & { willRetry: boolean };

export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| AgentSessionAgentEndEvent
	| { type: "agent_settled" }
	| { type: "session_abort" }
	| { type: "continuation_error"; errorMessage: string }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: CompactionReason; requestId?: string }
	| { type: "compaction_progress"; reason: CompactionReason; delta?: string; text?: string }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| ExtensionToolHookLifecycleEvent
	| SystemPromptChangeEvent
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "high_reasoning_warning"; modelId: string; provider: string; thinkingLevel: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			requestId?: string;
			accepted?: boolean;
			rejectionCause?: CompactionRejectionCause;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "retry_fallback_applied";
			from: string;
			to: string;
			chainKey: string;
			reason: "transient" | "refusal" | "hard-error" | "billing";
	  }
	| { type: "retry_fallback_succeeded"; model: string; chainKey: string }
	| { type: "retry_fallback_reverted"; from: string; to: string }
	| { type: "retry_fallback_exhausted"; chainKey: string; lastError: string }
	| { type: "server_fallback_aborted"; from: string; to: string; chainConfigured: boolean }
	// Auth login flow (task 13) is additive with event-only completion. The
	// login_start command responds immediately, then the OAuth URL and the
	// terminal result arrive here, because an interactive browser round-trip
	// cannot fit inside the request timeout.
	| { type: "auth_login_url"; provider: string; url: string }
	| { type: "auth_login_end"; provider: string; success: boolean; error?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: CompactionReason;
	  }
	| { type: "summarization_retry_finished" }
	| { type: "retry_probe_scheduled"; selector: string; atMs: number; probeIndex: 1 | 2 }
	| { type: "retry_probe_result"; selector: string; ok: boolean; errorMessage?: string }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Directory containing runtime logs and global agent configuration. */
	agentDir?: string;
	/** Clock override for fallback selector cooldowns (tests only). */
	fallbackNow?: () => number;
	/** Global model narrowing for selectors and startup model choice (from --models / enabledModels) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier }>;
	/** Favorite models to cycle through with Ctrl+P */
	favoriteModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime?: ModelRuntime;
	/** Legacy model facade retained for extensions and SDK consumers. */
	modelRegistry?: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	autoTitleSessions?: boolean;
}

type SessionModelEntry = { model: Model<any>; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier };

interface CompactionExecutionRequest {
	controller: AbortController;
	owner: "auto" | "compaction";
	reason: CompactionReason;
	requestId?: string;
	customInstructions?: string;
	willRetry: boolean;
	skipAbortedCheck?: boolean;
	lastAssistantMessage?: AgentMessage;
	precomputed?: CompactionResult;
	allowSummaryOnly?: boolean;
	agentMessagesAtStart?: readonly AgentMessage[];
}

type CompactionExecutionResult =
	| {
			accepted: true;
			requestId: string;
			result: CompactionResult;
			compactionEntry: CompactionEntry;
			fromExtension: boolean;
	  }
	| {
			accepted: false;
			requestId: string;
			rejectionCause: CompactionRejectionCause;
	  };

type PendingCompactionAdmission = {
	readonly controller: AbortController;
	readonly finishSessionWork: () => void;
	outcome?: "completed" | "failed" | "aborted";
};

function isCompactionOwnedPreCompactDiagnostic(message: AgentMessage, requestId: string): boolean {
	if (message.role !== "custom" || message.customType !== "senpi.hook") return false;
	const details = message.details;
	if (!details || typeof details !== "object") return false;
	const diagnostic = details as { event?: unknown; compactionRequestId?: unknown };
	return diagnostic.event === "PreCompact" && diagnostic.compactionRequestId === requestId;
}

/**
 * Human-readable rejection message paired with a `CompactionRejectionCause`.
 *
 * Kept exhaustive over the union so the compiler flags any new cause that would
 * otherwise reintroduce silent failures at the `compaction_end` UI seam.
 */
function describeCompactionRejection(cause: CompactionRejectionCause): string {
	switch (cause) {
		case "would-overflow":
			return "Compaction rejected: the produced summary would still overflow the model context window. Reduce context (e.g. /new, drop attachments) or switch to a larger-context model.";
		case "cancelled-by-extension":
			return "Compaction rejected: cancelled by an extension.";
		case "circuit-breaker":
			return "Compaction rejected: the compaction circuit breaker is open after repeated failures. Wait for the cooldown and retry.";
		case "per-turn-cap":
			// Historical cause identifier kept for extension-API stability; since the
			// per-turn soft cap was removed it fires only at the absolute session cap.
			return "Compaction rejected: absolute compaction cap reached for this session.";
		case "stale-revision":
			return "Compaction rejected: the session changed while the summary was being prepared. Retry compaction against the latest context.";
	}
}

class CompactionRejectedError extends Error {
	readonly rejectionCause: CompactionRejectionCause;

	constructor(rejectionCause: CompactionRejectionCause) {
		super(
			rejectionCause === "cancelled-by-extension"
				? "Compaction cancelled"
				: describeCompactionRejection(rejectionCause),
		);
		this.name = "CompactionRejectedError";
		this.rejectionCause = rejectionCause;
	}
}

class CompactionCancelledError extends Error {
	constructor() {
		super("Compaction cancelled");
		this.name = "CompactionCancelledError";
	}
}

/**
 * An execution failure annotated with whether this operation still owns its
 * terminal transition. Callers must not publish a terminal event for an
 * operation that a newer compaction generation has superseded.
 */
class CompactionExecutionError extends Error {
	readonly ownsTerminalTransition: boolean;
	readonly aborted: boolean;

	constructor(error: unknown, ownsTerminalTransition: boolean, aborted: boolean) {
		super(error instanceof Error ? error.message : String(error));
		this.name = "CompactionExecutionError";
		this.ownsTerminalTransition = ownsTerminalTransition;
		this.aborted = aborted;
	}
}

function compactionExecutionOwnsTerminalTransition(error: unknown): boolean {
	return !(error instanceof CompactionExecutionError) || error.ownsTerminalTransition;
}

function isCompactionExecutionAborted(error: unknown): boolean {
	return (
		(error instanceof CompactionExecutionError && error.aborted) ||
		error instanceof CompactionCancelledError ||
		(error instanceof Error && error.name === "AbortError")
	);
}

class RequiredCompactionError extends Error {
	constructor() {
		super("Context remains above the compaction threshold because compaction did not complete");
		this.name = "RequiredCompactionError";
	}
}

class MissingModelAccessError extends Error {
	constructor() {
		super("AgentSession requires modelRuntime or modelRegistry");
		this.name = "MissingModelAccessError";
	}
}
export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export type PromptDisposition = "handled" | "queued" | "started";

export type QueuedInput = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly enqueueOrder: number;
};

export type ClearedQueue = {
	steering: string[];
	followUp: string[];
	/** Global enqueue order, independent of native delivery priority. */
	readonly ordered: readonly QueuedInput[];
};

export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Session-only thinking level applied before starting this prompt. */
	thinkingLevel?: ThinkingLevel;
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Internal hook used by the TUI to distinguish handled input from owned prompt work. */
	promptDisposition?: (disposition: PromptDisposition) => void;
	/** Internal cancellation signal for a prompt that has not acquired session-work ownership yet. */
	signal?: AbortSignal;
	/** Internal callback used by fire-and-forget extension input to retain session-work ownership after its barrier wait. */
	onSessionWorkReady?: () => void;
	sessionTitlePrompt?: string | false;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling used the configured favorite model list */
	isScoped: boolean;
	/** Present when the model switch also changed the active system prompt. */
	systemPromptChange?: SystemPromptChangeEvent;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

function isSameOverflowSource(
	message: AssistantMessage,
	model: Model<Api>,
	upstreamModelId: string | undefined,
): boolean {
	if (message.provider !== model.provider) return false;
	if (message.model === model.id) return true;
	return message.model === upstreamModelId;
}

// ============================================================================
// Constants
// ============================================================================

/** Thinking levels including native max (Opus 4.6 legacy / Opus 4.7 native). */
const THINKING_LEVELS_WITH_MAX: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Caps explicit skill expansion so one prompt cannot consume unbounded context. */
export const MAX_SKILL_EXPANSIONS_PER_PROMPT = 5;

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: SessionModelEntry[];
	private _favoriteModels: SessionModelEntry[];

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _agentEventQueue: Promise<void> = Promise.resolve();
	/**
	 * Exact message objects whose message_end persistence is still queued.
	 * Agent core appends messages to agent.state.messages before emitting
	 * message_end; until that event settles on _agentEventQueue, compaction must
	 * treat these identities as pending persistence, never as stale or droppable.
	 */
	private readonly _messageEndsAwaitingPersistence = new Set<AgentMessage>();
	private _isAgentRunActive = false;
	private _toolExecutionDepth = 0;
	private _promptStartPending = false;
	private _nextInputId = 0;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Recovery-only order across both native queue modes and TUI compaction ownership. */
	private _queuedInputOrder: QueuedInput[] = [];
	private _nextQueuedInputOrder = 0;
	private _sessionLogger: SessionLogger;
	private _activeCompactionLogAttempt:
		| { id: string; reason: CompactionReason; tokensBefore: number | undefined }
		| undefined;
	private readonly _supersededCompactionLogAttemptIds = new Set<string>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	// Queues held while the first post-compaction response is classified. Agent
	// core otherwise drains steering immediately before AgentSession can consume
	// the stale-usage exemption and schedule the continuation itself.
	private _postCompactionDeferredSteeringMessages: AgentMessage[] = [];
	private _postCompactionDeferredFollowUpMessages: AgentMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _pendingCompactionAdmission: PendingCompactionAdmission | undefined = undefined;
	private readonly _compactionLifecycle = new CompactionLifecycleCoordinator();
	private readonly _sessionWorkBarrier = new SessionWorkBarrier();
	private _overflowRecoveryAttempted = false;
	private _requiredCompactionAdmissionError: RequiredCompactionError | undefined;
	// Preserve provenance across agent-core's conversion of our admission error
	// into an assistant error message. Matching provider text alone is not proof
	// that AgentSession initiated required-compaction recovery.
	private _requiredCompactionTurnError: RequiredCompactionError | undefined;
	// A retry continuation immediately follows an accepted compaction. Its first
	// response must not retrigger threshold compaction from stale provider usage.
	private _skipNextPostRetryCompactionCheck = false;
	private _blockedPostCompactionAssistant: { assistant: AssistantMessage; revision: number } | undefined;
	private _skipNextPostCompactionAssistantCheck = false;
	private _scheduledContinuationRecompacted = false;
	private readonly _assistantsPendingAtCompaction = new WeakSet<AssistantMessage>();
	private readonly _postCompactionUsageExemptAssistants = new WeakSet<AssistantMessage>();
	private _messageRevision = 0;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	private _sessionTitleAbortController: AbortController | undefined = undefined;
	private _sessionTitlePromise: Promise<void> | undefined = undefined;
	private readonly _autoTitleSessions: boolean;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _consecutiveProviderStreamStalls = 0;
	private _probePhase: ProbePhase = "idle";
	private _hintDeadlineMs: number | undefined = undefined;
	private _cumulativeHintedWaitMs = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _userAbortPromise: Promise<void> | undefined = undefined;
	private _agentAbortSource: "user" | "system" | undefined = undefined;
	private _suppressQueuedContinuationAfterUserAbort = false;
	/** Set when clearQueue({ abortWillFollow: true }) drains queues immediately before abort(). */
	private _hadClearedQueuedMessages = false;
	private _extensionEventSignal: AbortSignal | undefined = undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _extensionBindingPromptReadiness: Set<Promise<void>> | undefined;

	private _modelRuntime: ModelRuntime;
	private _modelRegistry: ModelRegistry;
	private readonly _fallbackValidationWarnings: readonly string[];
	private readonly _retryFallback: RetryFallbackController;
	private readonly _selectorCooldowns: SelectorCooldowns;
	private readonly _probeBackScheduler: ProbeBackScheduler;
	private readonly _fallbackNow: () => number;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _lazyToolActivators: LazyToolActivator[] = [];
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _currentServiceTier: ServiceTier | undefined = undefined;
	private _sessionFastMode = false;
	private readonly _shownHighReasoningWarningKeys = new Set<string>();
	private _baseSystemPromptOptions!: BuildDynamicSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		const noModelFallback =
			config.resourceLoader.getExtensions().runtime.flagValues.get("no-model-fallback") === true ||
			process.env.SENPI_NO_FALLBACK === "1";
		if (noModelFallback) {
			this.settingsManager.applyOverrides({ retry: { modelFallback: false } });
		}
		this._scopedModels = config.scopedModels ?? [];
		this._favoriteModels = config.favoriteModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		const modelRuntime = config.modelRuntime ?? config.modelRegistry?.modelRuntime;
		if (!modelRuntime) {
			throw new MissingModelAccessError();
		}
		this._modelRuntime = modelRuntime;
		this._modelRegistry = config.modelRegistry ?? new ModelRegistry(modelRuntime);
		this._agentDir = config.agentDir ?? getAgentDir();
		const fallbackLogger = createFallbackLogger(this._agentDir);
		this._sessionLogger = createSessionLogger(this._agentDir);
		this._fallbackValidationWarnings = validateFallbackChains(
			this.settingsManager.getRawFallbackChains(),
			this._modelRegistry,
		);
		// `source` names the scope that supplied the chains so a single log line
		// points at the file to open; "default" means no scope configured any.
		const fallbackChainsSource = this.settingsManager.getFallbackChainsScope() ?? "default";
		for (const warning of this._fallbackValidationWarnings) {
			fallbackLogger.warn("validation_warning", { warning, source: fallbackChainsSource });
		}
		this._selectorCooldowns = new SelectorCooldowns(config.fallbackNow ?? (() => Date.now()));
		this._fallbackNow = config.fallbackNow ?? (() => Date.now());
		this._retryFallback = new RetryFallbackController({
			getSettings: () => this.settingsManager.getRetryFallbackSettings(),
			registry: this._modelRegistry,
			cooldowns: this._selectorCooldowns,
			logger: fallbackLogger,
			switchModel: async (model, thinking, reason) => {
				await this._switchActiveModel(model, {
					persistDefault: false,
					appendSessionEntry: true,
					entryReason: reason,
					emitModelSelect: true,
					modelSelectSource: reason,
					invalidateCompaction: true,
					ephemeralThinkingLevel: thinking,
				});
			},
			emit: (event) => this._emit(event),
			getCurrentSelector: () => (this.model ? { model: this.model, thinkingLevel: this.thinkingLevel } : undefined),
			isAuthAvailable: (provider) => this._modelRuntime.hasConfiguredAuth(provider),
		});
		this._probeBackScheduler = new ProbeBackScheduler({
			now: this._fallbackNow,
		});
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._autoTitleSessions = config.autoTitleSessions ?? false;

		const initialModel = this.agent.state.model;
		if (initialModel) {
			const scopedMatch = this._scopedModels.find((sm) => modelsAreEqual(sm.model, initialModel));
			this._currentServiceTier = this._resolveServiceTier(initialModel, scopedMatch?.serviceTier);
		}

		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		extraBody?: Record<string, unknown>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			return {
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				extraBody: this._modelRuntime.getCompatibilityRequestConfig(model).extraBody,
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	/**
	 * Resolve optional auth for a summarization stream. Native/custom stream
	 * functions may provide ambient credentials, unlike streamSimple.
	 */
	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const apiKey = await this.agent.getApiKey?.(model.provider);
			const result = await this._modelRuntime.getAuth(model, { apiKey });
			return result
				? {
						apiKey: apiKey ?? result.auth.apiKey,
						headers: withoutDeletedHeaders(result.auth.headers),
						env: result.env,
					}
				: {};
		} catch {
			return {};
		}
	}

	private async _getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		extraBody?: Record<string, unknown>;
		env?: Record<string, string>;
	}> {
		const auth = await this._getSummarizationRequestAuth(model);
		return {
			...auth,
			extraBody: this._modelRuntime.getCompatibilityRequestConfig(model).extraBody,
		};
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	/**
	 * Surface a provider-level server-fallback abort before retry handling runs so
	 * the UI can explain the switch. Emitted synchronously here because retry work
	 * for the following agent_end starts before queued message_end processing
	 * drains. `chainConfigured` is required because the no-chain refusal path
	 * emits no retry_fallback_exhausted, leaving the UI no other signal.
	 */
	private _emitServerFallbackAborted(message: AssistantMessage): void {
		const details = message.diagnostics?.find((entry) => entry.type === SERVER_FALLBACK_ABORTED_DIAGNOSTIC)?.details;
		if (details === undefined) return;
		this._emit({
			type: "server_fallback_aborted",
			from: typeof details.from === "string" ? details.from : message.model,
			to: typeof details.to === "string" ? details.to : message.model,
			chainConfigured: this._retryFallback.hasConfiguredChain(),
		});
	}

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			this._toolExecutionDepth++;
			try {
				const result = await this._emitBeforeToolCallHooks(toolCall, args);
				if (result?.block) {
					this._toolExecutionDepth--;
				}
				return result;
			} catch (err) {
				this._toolExecutionDepth--;
				throw err;
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			try {
				return await this._emitAfterToolCallHooks(toolCall, args, result, isError);
			} finally {
				this._toolExecutionDepth--;
			}
		};
	}

	private async _emitBeforeToolCallHooks(
		toolCall: AgentToolCall,
		args: unknown,
		options: { waitForEventQueue?: boolean } = {},
	) {
		if (options.waitForEventQueue !== false) {
			await this._agentEventQueue;
		}

		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	private async _emitAfterToolCallHooks(
		toolCall: AgentToolCall,
		args: unknown,
		result: AgentToolResult<unknown>,
		isError: boolean,
	) {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_result")) {
			return undefined;
		}

		const hookResult = await runner.emitToolResult({
			type: "tool_result",
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			input: args as Record<string, unknown>,
			content: result.content,
			details: result.details,
			isError,
			usage: result.usage,
		});

		if (!hookResult) {
			return undefined;
		}

		return {
			content: hookResult.content,
			details: hookResult.details,
			isError: hookResult.isError ?? isError,
			usage: hookResult.usage,
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			// Enforce compaction only when this prepare precedes an actual provider
			// admission: a tool continuation or queued steer/follow-up messages. A
			// completed turn with no continuation keeps pre-PR timing, while the
			// prior prepare callback and context refresh below still run every turn.
			const compactBeforeNextAdmission = async (): Promise<boolean> => {
				if (turn.toolResults.length === 0 && !this.agent.hasQueuedMessages()) {
					return false;
				}
				await this._agentEventQueue;
				// A queue can be cleared while waiting for persistence. Re-sample it
				// immediately before compaction so a completed turn never compacts
				// merely because it once had a possible continuation.
				if (turn.toolResults.length === 0 && !this.agent.hasQueuedMessages()) {
					return false;
				}
				try {
					return await this._enforceCompactionBeforeProvider(turn.message, true, "threshold");
				} catch (error) {
					if (error instanceof RequiredCompactionError) {
						this._requiredCompactionTurnError = error;
						if (this.agent.hasQueuedMessages()) {
							this._requiredCompactionAdmissionError = error;
						}
					}
					throw error;
				}
			};

			const compactedBeforeCallback = await compactBeforeNextAdmission();
			const messages = compactedBeforeCallback ? this.agent.state.messages.slice() : turn.context.messages;

			const postCompactionTurn = {
				...turn,
				context: { ...turn.context, messages },
			};
			let previousSnapshot = await previousPrepareNextTurnWithContext?.(postCompactionTurn, signal);
			let previousContext = previousSnapshot?.context ?? postCompactionTurn.context;
			// The previous callback may await while agent_end extensions enqueue
			// continuation work. Re-sample after it returns so that work cannot
			// slip through with the stale provider snapshot it observed on entry.
			let compactedAfterCallback = false;
			if (!compactedBeforeCallback) {
				compactedAfterCallback = await compactBeforeNextAdmission();
			}
			if (compactedAfterCallback) {
				// The callback's first result describes the stale pre-compaction
				// context. Reapply it once to the compacted context so any host
				// transformation reaches the provider request. Do not re-sample after
				// this invocation: one replay is the bounded admission path.
				const postLateCompactionTurn = {
					...turn,
					context: { ...turn.context, messages: this.agent.state.messages.slice() },
				};
				const postLateCompactionSnapshot = await previousPrepareNextTurnWithContext?.(
					postLateCompactionTurn,
					signal,
				);
				previousSnapshot = {
					...previousSnapshot,
					...postLateCompactionSnapshot,
					context: postLateCompactionSnapshot?.context ?? postLateCompactionTurn.context,
				};
				previousContext = previousSnapshot.context ?? postLateCompactionTurn.context;
			}

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					messages: previousContext.messages,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		this._logSessionEvent(event);
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	/** Mirror stuck-prone lifecycle transitions into logs/session.log (content-free). */
	private _logSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "compaction_start") {
			const previousAttempt = this._activeCompactionLogAttempt;
			if (previousAttempt) {
				const tokensAfter = this._estimateCompactionLogTokens("persisted");
				this._sessionLogger.info("compaction_decision", {
					attemptId: previousAttempt.id,
					reason: previousAttempt.reason,
					mode: previousAttempt.reason === "manual" ? "manual" : "auto",
					action: "compact",
					disposition: "superseded",
					accepted: false,
					skipped: true,
					aborted: true,
					willRetry: false,
					tokensBefore: previousAttempt.tokensBefore,
					tokensAfter,
				});
				this._supersededCompactionLogAttemptIds.add(previousAttempt.id);
			}
			const attempt = {
				id: event.requestId ?? randomUUID(),
				reason: event.reason,
				tokensBefore: this._estimateCompactionLogTokens("persisted"),
			};
			this._activeCompactionLogAttempt = attempt;
			this._sessionLogger.info("compaction_start", {
				attemptId: attempt.id,
				reason: event.reason,
				mode: event.reason === "manual" ? "manual" : "auto",
				action: "compact",
				tokensBefore: attempt.tokensBefore,
			});
			return;
		}
		if (event.type === "compaction_end") {
			if (event.requestId && this._supersededCompactionLogAttemptIds.delete(event.requestId)) return;
			const activeAttempt = this._activeCompactionLogAttempt;
			const attempt =
				event.requestId !== undefined && activeAttempt?.id === event.requestId ? activeAttempt : undefined;
			const accepted = event.accepted ?? event.result !== undefined;
			const rejected = event.rejectionCause !== undefined;
			const skipped = !accepted && (attempt === undefined || (!rejected && !event.aborted && !event.errorMessage));
			const disposition = accepted
				? "committed"
				: attempt === undefined
					? "skipped"
					: rejected
						? "rejected"
						: event.aborted
							? "aborted"
							: event.errorMessage
								? "failed"
								: "skipped";
			const tokensAfter = this._estimateCompactionLogTokens(accepted ? "active" : "persisted");
			this._sessionLogger.info("compaction_decision", {
				attemptId: attempt?.id ?? event.requestId,
				reason: event.reason,
				mode: event.reason === "manual" ? "manual" : "auto",
				action: accepted || attempt ? "compact" : "none",
				disposition,
				accepted,
				skipped,
				aborted: event.aborted,
				willRetry: event.willRetry,
				rejectionCause: event.rejectionCause,
				error: event.errorMessage,
				tokensBefore: attempt?.tokensBefore ?? tokensAfter,
				tokensAfter,
			});
			if (attempt) this._activeCompactionLogAttempt = undefined;
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message as AssistantMessage;
			if (message.stopReason !== "error") return;
			const kind = isProviderStreamStallError(message)
				? "stall"
				: isProviderTimeoutError(message)
					? "timeout"
					: "error";
			this._sessionLogger.warn("provider_error", { kind, error: message.errorMessage });
		}
	}

	private _estimateCompactionLogTokens(source: "active" | "persisted"): number | undefined {
		try {
			const messages =
				source === "active" ? this.agent.state.messages : this.sessionManager.buildSessionContext().messages;
			return estimateMessagesTokens(filterContextExcludedMessages(messages));
		} catch {
			return undefined;
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _incrementMessageRevision(): void {
		this._messageRevision++;
		this._blockedPostCompactionAssistant = undefined;
	}

	getMessageRevision(): number {
		return this._messageRevision;
	}

	/** Resolved agent state directory for this session. */
	get agentDir(): string {
		return this._agentDir;
	}

	private async _waitForSettledSessionWork(): Promise<void> {
		await this._sessionWorkBarrier.waitForSettled(() => this._agentEventQueue);
	}

	async waitForSettledSessionWork(): Promise<void> {
		await this._waitForSettledSessionWork();
		const titlePromise = this._sessionTitlePromise;
		if (titlePromise !== undefined) {
			await titlePromise;
		}
		await this._waitForSettledSessionWork();
	}

	private _modelSelectionChangesContext(previousModel: Model<any> | undefined, nextModel: Model<any>): boolean {
		if (!modelsAreEqual(previousModel, nextModel)) return true;
		if (previousModel?.contextWindow !== nextModel.contextWindow) return true;
		return previousModel?.api !== nextModel.api;
	}

	private _invalidateCompactionForModelSelection(): void {
		this.abortCompaction();
		this.abortBranchSummary();
		this._incrementMessageRevision();
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		if (this.agent.state.isStreaming) {
			await this.agent.waitForIdle();
		}
		if (!this._isAgentRunActive) {
			this._resolveIdleWaitIfIdle();
			return;
		}
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	private async _promptAgent(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		this._requiredCompactionAdmissionError = undefined;
		this.agent.abortServerSideFallback =
			this.settingsManager.getAbortServerSideFallback() && this._retryFallback.hasConfiguredChain();
		try {
			await this.agent.prompt(messages);
			// AgentSession's subscriber intentionally queues event work instead of
			// blocking Agent core. Wait for this run's queued recovery decision
			// before reporting prompt completion to the caller.
			await this._agentEventQueue;
			const requiredCompactionError = this._requiredCompactionAdmissionError;
			this._requiredCompactionAdmissionError = undefined;
			if (requiredCompactionError) {
				this._sessionLogger.warn("prompt_rejected", { stage: "admission", error: "RequiredCompactionError" });
				throw requiredCompactionError;
			}
		} catch (error) {
			if (
				error instanceof Error &&
				error.message ===
					"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."
			) {
				const queuedMessages = Array.isArray(messages) ? messages : [messages];
				for (const message of queuedMessages) this.agent.steer(message);
				const userMessage = queuedMessages.find((message) => message.role === "user");
				if (userMessage?.role === "user") {
					const text = this._extractUserMessageText(userMessage.content);
					this._steeringMessages.push(text);
					this._recordQueuedInput(text, "steer");
					this._emitQueueUpdate();
				}
				return;
			}
			await this._emitAgentSettled();
			throw error;
		}
	}

	/** Extract text content used to track fork-owned queued user messages. */
	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent, signal: AbortSignal): void => {
		// Agent core drains native steer/follow-up queues immediately after its
		// final agent_end. This subscriber intentionally processes its own event
		// queue asynchronously, so a later recovery rejection cannot abort that
		// drain in time. agent_end itself is still an awaited synchronous boundary
		// before that drain: transfer every required overflow or threshold
		// compaction to AgentSession, retaining queues until recovery is accepted.
		if (event.type === "agent_end") {
			const lastAssistant = this._findLastAssistantInMessages(event.messages);
			const requiredAutoCompaction = lastAssistant
				? this._getRequiredAutoCompactionReason(lastAssistant)
				: undefined;
			if (requiredAutoCompaction) {
				this.agent.suppressQueuedMessageDrain();
			}
		}

		// Create retry promise synchronously before queueing async processing.
		// Agent.emit() calls this handler synchronously, and prompt() calls waitForRetry()
		// as soon as agent.prompt() resolves. If _retryPromise is created only inside
		// _processAgentEvent, slow earlier queued events can delay agent_end processing
		// and waitForRetry() can miss the in-flight retry.
		this._createRetryPromiseForAgentEnd(event);

		// The message object is already in agent.state.messages when message_end
		// fires; track its exact identity until this event's queued processing
		// settles so compaction can distinguish pending persistence from stale state.
		if (event.type === "message_end" && event.message.role === "assistant") {
			this._emitServerFallbackAborted(event.message);
		}

		const pendingMessage = event.type === "message_end" ? event.message : undefined;
		if (pendingMessage !== undefined) {
			this._messageEndsAwaitingPersistence.add(pendingMessage);
		}

		const processing = this._agentEventQueue.then(
			() => this._processAgentEvent(event, signal),
			() => this._processAgentEvent(event, signal),
		);
		this._agentEventQueue =
			pendingMessage !== undefined
				? processing.finally(() => {
						this._messageEndsAwaitingPersistence.delete(pendingMessage);
					})
				: processing;

		// Keep queue alive if an event handler fails
		this._agentEventQueue.catch(() => {});
	};

	private _createRetryPromiseForAgentEnd(event: AgentEvent): void {
		if (event.type !== "agent_end" || this._retryPromise) {
			return;
		}

		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return;
		}

		const lastAssistant = this._findLastAssistantInMessages(event.messages);
		if (
			!lastAssistant ||
			(!this._isRetryableError(lastAssistant) && !this._isHardErrorFallbackEligible(lastAssistant))
		) {
			return;
		}

		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
		// Agent core normally drains queued input immediately after agent_end.
		// Retry owns that continuation until its final provider-admission check has
		// either started it or reported a terminal rejection.
		this.agent.suppressQueuedMessageDrain();
	}

	private _findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Synchronously mirror the auto-compaction decision that _checkCompaction()
	 * will make after agent_end. Agent core drains queues before that async work
	 * runs, so only this preflight can transfer required admissions safely.
	 */
	private _getRequiredAutoCompactionReason(message: AssistantMessage): "overflow" | "threshold" | undefined {
		const reason = this._getAutoCompactionReason(message);
		// Retry and post-compaction exemptions only cover stale usage estimates.
		// A provider-confirmed overflow must always retain queue ownership and run
		// fail-closed recovery.
		if (
			reason === "overflow" &&
			message.stopReason === "stop" &&
			this._hasPendingPostCompactionUsageExemption(message)
		) {
			// A successful post-compaction response can carry stale provider usage.
			// Retain its queues while the asynchronous check consumes the exemption.
			return "threshold";
		}
		if (reason === "overflow") return reason;
		// Keep queued continuations under AgentSession ownership while the
		// asynchronous check consumes this post-compaction usage exemption.
		if (this._hasPendingPostCompactionUsageExemption(message)) return "threshold";
		if (
			reason === "threshold" &&
			(this._skipNextPostRetryCompactionCheck || this._postCompactionUsageExemptAssistants.has(message))
		) {
			return undefined;
		}
		return reason;
	}

	private _getAutoCompactionReason(message: AssistantMessage): "overflow" | "threshold" | undefined {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled || message.stopReason === "aborted") {
			return undefined;
		}

		const model = this.model;
		if (!model || this._isAssistantFromBeforeLatestCompaction(message)) {
			return undefined;
		}

		const sameModel = isSameOverflowSource(
			message,
			model,
			this._modelRuntime.getCompatibilityRequestConfig(model).upstreamModelId,
		);
		const contextUsage = this.getContextUsage();
		const currentContextNeedsCompaction =
			contextUsage !== undefined &&
			contextUsage.tokens !== null &&
			shouldCompact(contextUsage.tokens, contextUsage.contextWindow, settings);
		if (isContextOverflow(message, model.contextWindow) && (sameModel || currentContextNeedsCompaction)) {
			return "overflow";
		}

		let contextTokens: number;
		const directContextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
		if (message.stopReason !== "error" && directContextTokens !== 0) {
			contextTokens = directContextTokens;
		} else {
			const messages = filterContextExcludedMessages(this.agent.state.messages);
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) {
				if (!this._isRequiredCompactionError(message)) return undefined;
			} else {
				const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
				const usageMessage = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMessage?.role === "assistant" &&
					this._isAssistantFromBeforeLatestCompaction(usageMessage)
				) {
					return undefined;
				}
			}
			contextTokens = estimate.tokens;
		}

		return shouldCompact(contextTokens, model.contextWindow, settings) ? "threshold" : undefined;
	}

	private _hasPendingPostCompactionUsageExemption(message: AssistantMessage): boolean {
		return (
			this._skipNextPostCompactionAssistantCheck &&
			!this._assistantsPendingAtCompaction.has(message) &&
			!this._overflowRecoveryAttempted
		);
	}

	private _isPostCompactionUsageExempt(message: AssistantMessage): boolean {
		return (
			this._postCompactionUsageExemptAssistants.has(message) || this._hasPendingPostCompactionUsageExemption(message)
		);
	}

	private _consumePostCompactionUsageExemption(message: AssistantMessage): boolean {
		if (this._postCompactionUsageExemptAssistants.has(message)) return true;
		if (!this._isPostCompactionUsageExempt(message)) return false;
		this._skipNextPostCompactionAssistantCheck = false;
		this._postCompactionUsageExemptAssistants.add(message);
		return true;
	}

	private _agentEndAllowsQueuedContinuation(messages: AgentMessage[]): boolean {
		let lastAssistantIndex = -1;
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index]?.role === "assistant") {
				lastAssistantIndex = index;
				break;
			}
		}
		if (lastAssistantIndex === -1) {
			return false;
		}

		const lastAssistant = messages[lastAssistantIndex];
		if (lastAssistant?.role !== "assistant") {
			return false;
		}
		if (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") {
			return false;
		}
		if (this._getRequiredAutoCompactionReason(lastAssistant)) {
			return false;
		}

		for (let index = lastAssistantIndex + 1; index < messages.length; index++) {
			const message = messages[index];
			if (
				message?.role === "toolResult" &&
				message.isError &&
				message.content.some((content) => content.type === "text" && /\babort(?:ed)?\b/i.test(content.text))
			) {
				return false;
			}
		}

		return true;
	}

	private _willRetryAfterAgentEnd(messages: AgentMessage[]): boolean {
		const lastAssistant = this._lastAssistantMessage ?? this._findLastAssistantInMessages(messages);
		if (!lastAssistant) {
			return false;
		}
		if (
			this._isRequiredCompactionError(lastAssistant) &&
			this._getRequiredAutoCompactionReason(lastAssistant) !== undefined
		) {
			return true;
		}

		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		const retryableError = this._isRetryableError(lastAssistant);
		if (!retryableError && this._isHardErrorFallbackEligible(lastAssistant)) {
			return true;
		}

		if (!retryableError) {
			return false;
		}

		if (isClassifierRefusal(lastAssistant)) {
			return this._retryAttempt + 1 <= settings.maxRetries && this._retryFallback.canTryFallback();
		}

		if (this._retryAttempt + 1 > settings.maxRetries) {
			return this._retryFallback.canTryFallback();
		}

		const errorMessage = lastAssistant.errorMessage || "Unknown error";
		const providerDelayMs = this._getProviderRetryDelayMs(errorMessage);
		if (providerDelayMs === undefined) {
			return true;
		}

		if (providerDelayMs <= this.settingsManager.getProviderRetrySettings().maxRetryDelayMs) {
			return true;
		}
		return this._retryFallback.canTryFallback();
	}

	private _isRequiredCompactionError(message: AssistantMessage): boolean {
		return (
			this._requiredCompactionTurnError !== undefined &&
			message.stopReason === "error" &&
			message.errorMessage === this._requiredCompactionTurnError.message
		);
	}

	private async _processAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void> {
		if (event.type === "agent_start") {
			this._requiredCompactionTurnError = undefined;
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			this._retryFallback.resetTurn();
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._removeQueuedInput(messageText, "steer");
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._removeQueuedInput(messageText, "followUp");
						this._emitQueueUpdate();
					}
				}
			}
		}

		const agentEndWillRetry = event.type === "agent_end" && this._willRetryAfterAgentEnd(event.messages);

		// Emit to extensions first. Agent event persistence is intentionally
		// asynchronous, so retain the source run signal while dispatching.
		this._extensionEventSignal = signal;
		try {
			await this._emitExtensionEvent(event, agentEndWillRetry);
		} finally {
			this._extensionEventSignal = undefined;
		}

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: agentEndWillRetry } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
				this._incrementMessageRevision();
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
				this._incrementMessageRevision();
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				const succeeded =
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					!isClassifierRefusal(assistantMsg);
				if (succeeded) {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry state only after a genuinely successful response. Provider
				// transport timeouts can arrive as `aborted` and must keep consuming the
				// same bounded retry budget instead of reporting a false success.
				if (succeeded && this._retryAttempt > 0) {
					const fallback = this._retryFallback.activeState;
					if (fallback) {
						this._emit({
							type: "retry_fallback_succeeded",
							model: this.model ? `${this.model.provider}/${this.model.id}` : "",
							chainKey: fallback.chainKey,
						});
					}
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
					this._resetHintTierState();
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes.
		let launchedContinuation = false;
		let retryContinuationBlocked = false;
		let allowsPostCompactionUsageExemptContinuation = false;
		const userAbortSuppressedQueuedContinuation =
			event.type === "agent_end" && this._suppressQueuedContinuationAfterUserAbort;
		if (userAbortSuppressedQueuedContinuation) {
			this._suppressQueuedContinuationAfterUserAbort = false;
		}
		const allowsQueuedContinuation =
			event.type === "agent_end" && !userAbortSuppressedQueuedContinuation
				? this._agentEndAllowsQueuedContinuation(event.messages)
				: false;
		if (event.type === "agent_end" && this._lastAssistantMessage) {
			const msg = this._lastAssistantMessage;
			this._lastAssistantMessage = undefined;
			this._skipNextPostRetryCompactionCheck = false;
			const requiredAutoCompaction = this._getRequiredAutoCompactionReason(msg);
			const retryAfterRequiredCompaction =
				requiredAutoCompaction !== undefined && this._isRequiredCompactionError(msg);

			// Retry transient failures normally and eligible hard errors only through a fallback.
			const retryableError = this._isRetryableError(msg);
			const hardErrorFallbackEligible = this._isHardErrorFallbackEligible(msg);
			const retryCanAdmitProvider =
				this.settingsManager.getRetrySettings().enabled && (retryableError || hardErrorFallbackEligible);
			let compactedBeforeRetry = false;
			if (
				retryCanAdmitProvider &&
				requiredAutoCompaction &&
				!(requiredAutoCompaction === "threshold" && this._hasPendingPostCompactionUsageExemption(msg))
			) {
				this._retireFailedRetryAssistant(msg);
				compactedBeforeRetry = await this._runPrePromptCompaction(msg, true, "threshold", true);
				retryContinuationBlocked = !compactedBeforeRetry;
			}

			let retryOutcome: "continued" | "blocked" | "not-handled" = "not-handled";
			if (!retryContinuationBlocked) {
				if (retryableError) {
					retryOutcome = await this._handleRetryableError(msg);
				} else if (hardErrorFallbackEligible) {
					retryOutcome = await this._handleRetryableError(msg, { hardErrorFallback: true });
				}
			}
			if (retryOutcome === "continued") return;

			this._resolveRetry();
			retryContinuationBlocked ||= retryOutcome === "blocked";
			if (!retryContinuationBlocked) {
				if (compactedBeforeRetry && this.agent.hasQueuedMessages()) {
					// Accepted recovery supersedes the stored admission rejection: the
					// queued continuation is about to run, so the originating prompt must
					// not observe the stale RequiredCompactionError.
					this._requiredCompactionAdmissionError = undefined;
					this._scheduleContinuationAfterCurrentEvent();
					launchedContinuation = true;
				} else {
					launchedContinuation = await this._checkCompaction(msg, true, undefined, retryAfterRequiredCompaction);
					if (launchedContinuation && this.agent.hasQueuedMessages()) {
						// Same supersession on the post-check path: an accepted recovery
						// compaction owns the continuation now.
						this._requiredCompactionAdmissionError = undefined;
					}
					allowsPostCompactionUsageExemptContinuation = this._postCompactionUsageExemptAssistants.has(msg);
					if (allowsPostCompactionUsageExemptContinuation) {
						this._flushPostCompactionDeferredMessages();
					}
					// _runAutoCompaction() returns false both when recovery was rejected and
					// when an accepted compaction had no queue to continue. Re-sample after
					// it settles so only the still-required (rejected) case fails admission.
					if (
						requiredAutoCompaction &&
						!launchedContinuation &&
						this.agent.hasQueuedMessages() &&
						this._getRequiredAutoCompactionReason(msg) !== undefined
					) {
						this._requiredCompactionAdmissionError = new RequiredCompactionError();
					}
				}
			}
		}

		if (event.type === "agent_end") {
			this._flushPendingBashMessages();
			if (
				!launchedContinuation &&
				!retryContinuationBlocked &&
				(allowsQueuedContinuation || allowsPostCompactionUsageExemptContinuation) &&
				this.agent.hasQueuedMessages()
			) {
				// A scheduled continuation owns the queue now; the stored admission
				// rejection from a superseded required compaction must not surface.
				this._requiredCompactionAdmissionError = undefined;
				this._scheduleContinuationAfterCurrentEvent();
				launchedContinuation = true;
			}
			if (!launchedContinuation) {
				await this._emitAgentSettled();
			}
		}
	}

	/** Resolve the pending retry promise */
	private _resolveRetry(): void {
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
		}
	}

	private _resetHintTierState(): void {
		this._probePhase = "idle";
		this._hintDeadlineMs = undefined;
		this._cumulativeHintedWaitMs = 0;
	}

	/**
	 * Arm the probe-back scheduler for a tier-2 demoted selector. The scheduler
	 * will fire at most two probes (half-hint, then deadline) and clear the
	 * selector cooldown on success so maybeRestorePrimary reverts at the next
	 * turn boundary.
	 */
	private _armProbeBackForDemotedSelector(selector: string, hintMs: number): void {
		if (!selector) return;

		// Guard: skip when the demoted selector is the ACTIVE model.
		const currentModel = this.model;
		if (currentModel && formatSelector(currentModel) === selector) return;

		// Guard: skip when auth is unavailable at arm time.
		const parts = selector.split("/");
		if (parts.length < 2) return;
		const provider = parts[0];
		if (!this._modelRuntime.hasConfiguredAuth(provider)) return;

		const now = this._fallbackNow();
		const schedule = probeBackSchedule(hintMs, now);
		const modelId = parts.slice(1).join("/");
		const demotedModel = this._modelRuntime.getModel(provider, modelId);
		if (!demotedModel) return;

		this._probeBackScheduler.arm({
			selector,
			firstAtMs: schedule.firstAtMs,
			deadlineMs: schedule.deadlineMs,
			authAvailable: () => this._modelRuntime.hasConfiguredAuth(provider),
			runProbe: async (signal: AbortSignal): Promise<boolean> => {
				try {
					const result = await this._modelRuntime.completeSimple(
						demotedModel,
						{
							systemPrompt: "Reply with OK.",
							messages: [{ role: "user", content: [{ type: "text", text: "OK" }], timestamp: now }],
						},
						{ maxTokens: 1, signal },
					);
					return result.stopReason !== "error" && result.stopReason !== "aborted";
				} catch {
					return false;
				}
			},
			onCleared: (sel: string) => {
				this._selectorCooldowns.clear(sel);
			},
			emit: (event) => {
				if (event.type === "retry_probe_scheduled") {
					this._emit({
						type: "retry_probe_scheduled",
						selector: event.selector,
						atMs: event.atMs,
						probeIndex: event.probeIndex,
					});
				} else {
					this._emit({
						type: "retry_probe_result",
						selector: event.selector,
						ok: event.ok,
						errorMessage: event.errorMessage,
					});
				}
			},
		});
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Retry failures stay in append-only history but must not be retained in the
	 * active context branch. Otherwise split-turn compaction keeps the failed
	 * assistant response verbatim and cannot make progress before a retry.
	 */
	private _retireFailedRetryAssistant(message: AssistantMessage): void {
		const position = this.sessionManager.getMessageEntryPosition(message);
		if (!position || this.sessionManager.getLeafId() !== position.entryId) return;
		const entry = this.sessionManager.getEntry(position.entryId);
		if (entry?.type !== "message") return;

		if (entry.parentId === null) {
			this.sessionManager.resetLeaf();
		} else {
			this.sessionManager.branch(entry.parentId);
		}
		const messageIndex = this.agent.state.messages.lastIndexOf(message);
		if (messageIndex !== -1) {
			this.agent.state.messages = this.agent.state.messages.slice(0, messageIndex);
		}
		this._incrementMessageRevision();
	}

	private _isAssistantFromBeforeLatestCompaction(assistantMessage: AssistantMessage): boolean {
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (compactionEntry === null) return false;

		// An agent message_end can still be awaiting persistence while compaction
		// commits. It is necessarily a post-boundary message, even when a provider
		// supplied an older payload timestamp.
		if (this._messageEndsAwaitingPersistence.has(assistantMessage)) return false;

		const messagePosition = this.sessionManager.getMessageEntryPosition(assistantMessage);
		const compactionOrder = this.sessionManager.getEntryOrder(compactionEntry.id);
		if (messagePosition !== undefined && compactionOrder !== undefined) {
			return messagePosition.order <= compactionOrder;
		}

		// Reloaded/reconstructed messages have no runtime identity. Retain the
		// historical timestamp heuristic only for that compatibility path.
		return assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _processAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		for (const key of Object.keys(target)) {
			Reflect.deleteProperty(target, key);
		}
		Object.assign(target, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent, agentEndWillRetry = false): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			const abortSource = this._agentAbortSource;
			const aborted =
				abortSource !== undefined || this._findLastAssistantInMessages(event.messages)?.stopReason === "aborted";
			try {
				await this._extensionRunner.emit({
					type: "agent_end",
					messages: event.messages,
					willRetry: agentEndWillRetry,
					...(aborted ? { aborted: true } : {}),
					...(abortSource === undefined ? {} : { abortSource }),
				});
			} finally {
				this._agentAbortSource = undefined;
			}
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this._probeBackScheduler.cancel("dispose");
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortSessionTitleGeneration();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get serviceTier(): ServiceTier | undefined {
		return this._currentServiceTier;
	}

	/**
	 * True when the active model is served at the priority ("fast") tier: either the model
	 * itself is configured for it (an `openai` `-fast` catalog variant, a scoped
	 * `provider/id:priority`) or an extension turned fast mode on for this session.
	 *
	 * Display-only: it never feeds request composition, so an extension toggling fast mode
	 * for one provider cannot leak `service_tier` into another provider's payload.
	 * `serviceTier` stays the single request-side source.
	 */
	isFastModeActive(): boolean {
		return this._sessionFastMode || this._currentServiceTier === "priority";
	}

	/** Session-scoped fast-mode indicator; never persisted, reset on session start. */
	setSessionFastMode(enabled: boolean): void {
		this._sessionFastMode = enabled;
	}

	/**
	 * Explicit scoped/favorite tiers win; otherwise fall back to the model's
	 * configured serviceTier from models.json/extension compatibility config.
	 */
	private _resolveServiceTier(
		model: Model<any> | undefined,
		explicit: ServiceTier | undefined,
	): ServiceTier | undefined {
		if (explicit) return explicit;
		if (!model) return undefined;
		return this._modelRuntime.getCompatibilityRequestConfig(model).serviceTier;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	async executeTool<TDetails = unknown>(
		toolName: string,
		params: unknown,
		options?: ExecuteToolOptions<TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		let activeTools = this.getActiveToolNames();
		let tool = this.agent.state.tools.find((candidate) => candidate.name === toolName);
		if (
			!tool &&
			options?.activateInactiveTool === true &&
			this._toolDefinitions.has(toolName) &&
			this._activateLazyTool(toolName)
		) {
			activeTools = this.getActiveToolNames();
			tool = this.agent.state.tools.find((candidate) => candidate.name === toolName);
		}
		if (!tool) {
			const knownToolNames = new Set(this._toolDefinitions.keys());
			const code = knownToolNames.has(toolName) ? "inactive_tool" : "unknown_tool";
			const activeList = activeTools.length > 0 ? activeTools.join(", ") : "(none)";
			throw new ExecuteToolError(
				code,
				toolName,
				code === "inactive_tool"
					? `Tool ${toolName} is registered but inactive. Active tools: ${activeList}`
					: `Unknown tool ${toolName}. Active tools: ${activeList}`,
				activeTools,
			);
		}

		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `codemode-${randomUUID()}`,
			name: toolName,
			arguments: params as Record<string, unknown>,
		};

		let prepared: PreparedAgentToolCall;
		try {
			prepared = prepareAgentToolCall(tool, toolCall);
		} catch (err) {
			throw new ExecuteToolError(
				"invalid_params",
				toolName,
				err instanceof Error ? err.message : String(err),
				activeTools,
			);
		}

		const beforeResult = await this._emitBeforeToolCallHooks(prepared.toolCall, prepared.args, {
			waitForEventQueue: this._toolExecutionDepth === 0,
		});
		if (beforeResult?.block) {
			throw new ExecuteToolError(
				"blocked",
				toolName,
				beforeResult.reason || "Tool execution was blocked",
				activeTools,
			);
		}

		let result: AgentToolResult<unknown>;
		let isError = false;
		try {
			result = await prepared.tool.execute(
				prepared.toolCall.id,
				prepared.args as never,
				options?.signal,
				options?.onUpdate as AgentToolUpdateCallback<unknown> | undefined,
			);
		} catch (err) {
			result = {
				content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
				details: { isError: true },
			};
			isError = true;
		}
		const hookResult = await this._emitAfterToolCallHooks(prepared.toolCall, prepared.args, result, isError);

		if (!hookResult) {
			return result as AgentToolResult<TDetails>;
		}

		return {
			content: hookResult.content ?? result.content,
			details: (hookResult.details ?? result.details) as TDetails,
			terminate: result.terminate,
		};
	}

	/** Lets a registering extension activate its own inactive tool on demand; it owns eligibility. */
	private _activateLazyTool(toolName: string): boolean {
		return this._lazyToolActivators.some((activate) => activate(toolName));
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		const activeToolNamesChanged =
			validToolNames.length !== this.agent.state.tools.length ||
			validToolNames.some((name, index) => name !== this.agent.state.tools[index]?.name);
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
		if (activeToolNamesChanged) {
			this.abortCompaction();
			this._incrementMessageRevision();
		}
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._pendingCompactionAdmission !== undefined ||
			this._compactionLifecycle.state.status === "running" ||
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	get compactionState(): Readonly<CompactionLifecycleState> {
		return this._compactionLifecycle.state;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Globally narrowed models (from --models / enabledModels) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier }> {
		return this._scopedModels;
	}

	/** Update global model narrowing */
	setScopedModels(
		scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier }>,
	): void {
		this._scopedModels = scopedModels;
	}

	/** Favorite models for Ctrl+P cycling */
	get favoriteModels(): ReadonlyArray<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
		serviceTier?: ServiceTier;
	}> {
		return this._getCurrentFavoriteModels();
	}

	/** Update favorite models for Ctrl+P cycling */
	setFavoriteModels(
		favoriteModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier }>,
	): void {
		this._favoriteModels = favoriteModels;
	}

	private _getCurrentFavoriteModels(): SessionModelEntry[] {
		const availableById = new Map(
			this._modelRuntime.getAvailableSnapshot().map((model) => [`${model.provider}/${model.id}`, model]),
		);
		const narrowedModelIds =
			this._scopedModels.length > 0
				? new Set(this._scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`))
				: undefined;
		const seenModelIds = new Set<string>();
		const favoriteModels: SessionModelEntry[] = [];

		for (const favorite of this._favoriteModels) {
			const modelId = `${favorite.model.provider}/${favorite.model.id}`;
			if (seenModelIds.has(modelId)) continue;

			const model = availableById.get(modelId);
			if (!model) continue;
			if (narrowedModelIds && !narrowedModelIds.has(modelId)) continue;

			seenModelIds.add(modelId);
			favoriteModels.push({
				model,
				thinkingLevel: favorite.thinkingLevel,
				serviceTier: favorite.serviceTier,
			});
		}

		return favoriteModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		const basePrompt = loaderSystemPrompt ?? buildDynamicSystemPrompt(this._baseSystemPromptOptions);
		return loaderAppendSystemPrompt.length > 0
			? `${basePrompt}\n\n${loaderAppendSystemPrompt.join("\n\n")}`
			: basePrompt;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const throwIfCancelled = (): void => {
			if (!options?.signal?.aborted) return;
			const error = new Error("Prompt cancelled before acceptance");
			error.name = "AbortError";
			throw error;
		};
		throwIfCancelled();
		const userAbortPromise = this._userAbortPromise;
		if (userAbortPromise) {
			await userAbortPromise;
			throwIfCancelled();
		}
		const ownsPromptStart =
			!this.isStreaming && !this._promptStartPending && options?.streamingBehavior === undefined;
		if (ownsPromptStart) this._promptStartPending = true;
		// Extension bindings deliberately fire-and-forget sendUserMessage(), so an
		// extension callback cannot deadlock on this wait. The resulting provider
		// turn must still serialize behind compaction and other session work just
		// like an interactive prompt does.
		const shouldWaitForSessionWork = true;
		const pendingCompactionAdmissionAtExtensionAdmission =
			options?.source === "extension" ? this._pendingCompactionAdmission : undefined;
		const compactionGenerationAtExtensionAdmission =
			options?.source === "extension" &&
			this._sessionWorkBarrier.hasActiveWork &&
			this._compactionLifecycle.state.status !== "idle"
				? this._compactionLifecycle.state.generation
				: undefined;
		// A steer/followUp submission during an active run can be queued immediately.
		// Waiting on the session-work barrier here would trap the message inside this
		// call for the rest of the run whenever a queued continuation (e.g. an active
		// goal chain) holds the barrier, making typed input invisible until the run
		// ends or the user aborts.
		const canQueueWhileStreaming =
			(this.isStreaming || this._promptStartPending) &&
			!this.isCompacting &&
			options?.streamingBehavior !== undefined;
		if (
			shouldWaitForSessionWork &&
			!canQueueWhileStreaming &&
			(!this.isStreaming || this.isCompacting || this._sessionWorkBarrier.hasActiveWork)
		) {
			await this._waitForSettledSessionWork();
			throwIfCancelled();
			options?.onSessionWorkReady?.();
		}

		// Turn boundary: restore the primary model if the fallback cooldown expired.
		if (!this.isStreaming) {
			try {
				await this._maybeRestoreFallbackPrimary();
			} catch (error) {
				if (ownsPromptStart) this._promptStartPending = false;
				throw error;
			}
		}

		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		const promptDisposition = options?.promptDisposition;
		let messages: AgentMessage[] | undefined;
		let titlePrompt: string | undefined;
		let consumedNextTurnMessages: CustomMessage[] | undefined;
		let inputId: string | undefined;
		const emitInputDisposition = async (
			disposition: "handled" | "queued" | "started" | "rejected",
		): Promise<void> => {
			if (inputId === undefined) return;
			await this._extensionRunner.emit({ type: "input_disposition", inputId, disposition });
		};

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				throwIfCancelled();
				if (handled) {
					// Extension command executed, no prompt to send
					promptDisposition?.("handled");
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				inputId = `${this.sessionManager.getSessionId()}:${++this._nextInputId}`;
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
					inputId,
				);
				throwIfCancelled();
				if (inputResult.action === "handled") {
					await emitInputDisposition("handled");
					promptDisposition?.("handled");
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}
			titlePrompt = options?.sessionTitlePrompt === false ? undefined : (options?.sessionTitlePrompt ?? text);

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.thinkingLevel !== undefined) {
					throw new Error("Cannot set thinkingLevel on a queued prompt; set it after the current turn completes.");
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				await emitInputDisposition("queued");
				promptDisposition?.("queued");
				preflightResult?.(true);
				return;
			}

			// Input accepted while a run was active remains queued even if that run
			// ends while extension input handling or template expansion is pending.
			// Starting a fresh prompt here would let it overtake the held continuation.
			if (canQueueWhileStreaming && !this.isStreaming) {
				if (options?.thinkingLevel !== undefined) {
					throw new Error("Cannot set thinkingLevel on a queued prompt; set it after the current turn completes.");
				}
				if (options?.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				await emitInputDisposition("queued");
				promptDisposition?.("queued");
				preflightResult?.(true);
				return;
			}

			// The queue-while-streaming bypass above skipped the settled-work wait. If
			// the run ended while input was being expanded, serialize with remaining
			// session work before sending a fresh prompt, and re-queue if a scheduled
			// continuation started a new run in the meantime.
			if (
				canQueueWhileStreaming &&
				shouldWaitForSessionWork &&
				(this.isCompacting || this._sessionWorkBarrier.hasActiveWork)
			) {
				await this._waitForSettledSessionWork();
				throwIfCancelled();
				if (this.isStreaming) {
					if (options?.thinkingLevel !== undefined) {
						throw new Error(
							"Cannot set thinkingLevel on a queued prompt; set it after the current turn completes.",
						);
					}
					if (options?.streamingBehavior === "followUp") {
						await this._queueFollowUp(expandedText, currentImages);
					} else {
						await this._queueSteer(expandedText, currentImages);
					}
					await emitInputDisposition("queued");
					promptDisposition?.("queued");
					preflightResult?.(true);
					return;
				}
			}

			// A background extension prompt that arrived during a manual compaction
			// must never overtake a rejected or aborted compaction. Keep its normal
			// queue ownership instead of attempting another provider admission.
			if (
				(pendingCompactionAdmissionAtExtensionAdmission !== undefined &&
					pendingCompactionAdmissionAtExtensionAdmission.outcome !== "completed") ||
				(compactionGenerationAtExtensionAdmission !== undefined &&
					this._compactionLifecycle.state.generation === compactionGenerationAtExtensionAdmission &&
					(this._compactionLifecycle.state.status === "failed" ||
						this._compactionLifecycle.state.status === "aborted"))
			) {
				if (options?.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				await emitInputDisposition("queued");
				promptDisposition?.("queued");
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// The user's new prompt is sent below, so do not call agent.continue() here.
			await this._enforceCompactionBeforeProvider(this._findLastAssistantMessage(), false, "pre_prompt");

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Consume next-turn messages transactionally: a final admission rejection
			// restores them in their original order rather than dropping or duplicating
			// one-shot extension state.
			consumedNextTurnMessages = this._pendingNextTurnMessages;
			this._pendingNextTurnMessages = [];
			for (const msg of consumedNextTurnMessages) {
				messages.push(msg);
			}

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}

			// The preflight above only sees persisted session context. These prompt,
			// next-turn, and before_agent_start additions are also provider-visible,
			// so make one final admission decision against the complete request.
			await this._enforceFinalProviderAdmission(messages);
			throwIfCancelled();
			await emitInputDisposition("started");
		} catch (error) {
			await emitInputDisposition("rejected");
			if (consumedNextTurnMessages && consumedNextTurnMessages.length > 0) {
				this._pendingNextTurnMessages = [...consumedNextTurnMessages, ...this._pendingNextTurnMessages];
			}
			preflightResult?.(false);
			throw error;
		} finally {
			if (ownsPromptStart) this._promptStartPending = false;
		}

		if (!messages) {
			return;
		}

		promptDisposition?.("started");
		preflightResult?.(true);
		if (options?.thinkingLevel !== undefined) {
			this.setSessionThinkingLevel(options.thinkingLevel);
		}
		await this._promptAgent(messages);
		await this.waitForRetry();
		await this.waitForIdle();
		if (options?.onSessionWorkReady) {
			// This prompt owns a session-work token acquired after waiting for a
			// prior operation, so waiting for the global barrier here would await
			// itself. _promptAgent() already drained its event queue; any newly
			// scheduled continuation retains its own barrier ownership.
			await this.agent.waitForIdle();
		} else if (shouldWaitForSessionWork) {
			await this._waitForSettledSessionWork();
		} else {
			await this.agent.waitForIdle();
		}
		if (titlePrompt !== undefined) {
			this._startSessionTitleGeneration(titlePrompt);
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand a leading run of skill commands (/skill:name /skill:other args) to their full content.
	 * Returns the expanded text, or the original text if the first skill command is not found.
	 * Emits errors via extension runner if file reads fail or the expansion cap is reached.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const skills = this.resourceLoader.getSkills().skills;
		const expandedSkillNames = new Set<string>();
		const skillBlocks: string[] = [];
		let tokenStart = 0;

		while (tokenStart < text.length) {
			let tokenEnd = tokenStart;
			while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) {
				tokenEnd += 1;
			}
			const token = text.slice(tokenStart, tokenEnd);
			if (!token.startsWith("/skill:")) break;

			const skillName = token.slice(7);
			const skill = skills.find((candidate) => candidate.name === skillName);
			if (!skill) break; // Unknown skills and everything after them remain literal text.

			if (!expandedSkillNames.has(skill.name)) {
				if (skillBlocks.length >= MAX_SKILL_EXPANSIONS_PER_PROMPT) {
					this._extensionRunner.emitError({
						extensionPath: "skill:expansion",
						event: "skill_expansion",
						error: `Expanded at most ${MAX_SKILL_EXPANSIONS_PER_PROMPT} skills; remaining skill commands were left as literal text.`,
					});
					break;
				}

				try {
					const content = readFileSync(skill.filePath, "utf-8");
					const body = stripFrontmatter(content).trim();
					skillBlocks.push(
						`<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
					);
					expandedSkillNames.add(skill.name);
				} catch (err) {
					this._extensionRunner.emitError({
						extensionPath: skill.filePath,
						event: "skill_expansion",
						error: err instanceof Error ? err.message : String(err),
					});
					return text; // Return the original prompt when any skill file cannot be read.
				}
			}

			tokenStart = tokenEnd;
			while (tokenStart < text.length && /\s/.test(text[tokenStart]!)) {
				tokenStart += 1;
			}
		}

		if (skillBlocks.length === 0) return text;

		const args = text.slice(tokenStart).trim();
		const expandedSkills = skillBlocks.join("\n\n");
		return args ? `${expandedSkills}\n\n${args}` : expandedSkills;
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], recovery?: { enqueueOrder?: number }): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images, recovery?.enqueueOrder);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[], recovery?: { enqueueOrder?: number }): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images, recovery?.enqueueOrder);
	}

	private _startSessionTitleGeneration(firstPrompt: string): void {
		if (!this._autoTitleSessions || this.sessionManager.getSessionName() || shouldSkipSessionTitle(firstPrompt)) {
			return;
		}
		if (this._sessionTitleAbortController !== undefined) {
			return;
		}
		const model = this.model;
		if (!model) {
			return;
		}
		const abortController = new AbortController();
		this._sessionTitleAbortController = abortController;
		this._sessionTitlePromise = this._generateSessionTitle(firstPrompt, model, abortController);
	}

	private async _generateSessionTitle(
		firstPrompt: string,
		model: Model<Api>,
		abortController: AbortController,
	): Promise<void> {
		try {
			const auth = await this._getCompactionRequestAuth(model);
			const title = await generateSessionTitle({
				firstPrompt,
				model,
				auth,
				sessionId: this.sessionId,
				baseOptions: this._buildSessionTitleBaseOptions(),
				retry: sessionTitleRetryPolicy(this.settingsManager.getRetrySettings()),
				signal: abortController.signal,
				streamFn: this.agent.streamFunction,
			});
			if (abortController.signal.aborted) {
				return;
			}
			if (title && !this.sessionManager.getSessionName()) {
				this.setSessionName(title);
			}
		} catch (error) {
			if (abortController.signal.aborted) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this._extensionRunner.emitError({
				extensionPath: RUNTIME_EXTENSION_PATH,
				event: "session_title_generation",
				error: message,
			});
		} finally {
			if (this._sessionTitleAbortController === abortController) {
				this._sessionTitleAbortController = undefined;
			}
			if (this._sessionTitlePromise !== undefined) {
				this._sessionTitlePromise = undefined;
			}
		}
	}

	private abortSessionTitleGeneration(): void {
		this._sessionTitleAbortController?.abort();
		this._sessionTitleAbortController = undefined;
	}

	private _buildSessionTitleBaseOptions(): SimpleStreamOptions {
		return {
			onPayload: this.agent.onPayload,
			onResponse: this.agent.onResponse,
			transport: this.agent.transport,
			thinkingBudgets: this.agent.thinkingBudgets,
			timeoutMs: this.agent.timeoutMs,
			maxRetryDelayMs: this.agent.maxRetryDelayMs,
		};
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[], enqueueOrder?: number): Promise<void> {
		this._steeringMessages.push(text);
		this._recordQueuedInput(text, "steer", enqueueOrder);
		this._sessionLogger.debug("queue_enqueue", { mode: "steer", count: this._steeringMessages.length });
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		if (this._promptStartPending && this._skipNextPostCompactionAssistantCheck) {
			this._postCompactionDeferredSteeringMessages.push(message);
			return;
		}
		this.agent.steer(message);
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[], enqueueOrder?: number): Promise<void> {
		this._followUpMessages.push(text);
		this._recordQueuedInput(text, "followUp", enqueueOrder);
		this._sessionLogger.debug("queue_enqueue", { mode: "followUp", count: this._followUpMessages.length });
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		if (this._promptStartPending && this._skipNextPostCompactionAssistantCheck) {
			this._postCompactionDeferredFollowUpMessages.push(message);
			return;
		}
		this.agent.followUp(message);
	}

	private _flushPostCompactionDeferredMessages(): void {
		for (const message of this._postCompactionDeferredSteeringMessages) {
			this.agent.steer(message);
		}
		this._postCompactionDeferredSteeringMessages = [];
		for (const message of this._postCompactionDeferredFollowUpMessages) {
			this.agent.followUp(message);
		}
		this._postCompactionDeferredFollowUpMessages = [];
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		const waitForExistingSessionWork =
			options?.triggerTurn === true &&
			options.deliverAs !== "nextTurn" &&
			!this.isStreaming &&
			this._sessionWorkBarrier.hasActiveWork;
		const pendingCompactionAdmission = this._pendingCompactionAdmission;
		const activeCompactionGeneration =
			this._compactionLifecycle.state.status === "running" ? this._compactionLifecycle.state.generation : undefined;
		let finishSessionWork: (() => void) | undefined;
		try {
			if (waitForExistingSessionWork) {
				await this._waitForSettledSessionWork();
				finishSessionWork = this._sessionWorkBarrier.begin();
			}

			if (options?.deliverAs === "nextTurn") {
				this._pendingNextTurnMessages.push(appMessage);
			} else if (this.isStreaming) {
				if (options?.deliverAs === "followUp") {
					this.agent.followUp(appMessage);
				} else {
					this.agent.steer(appMessage);
				}
			} else if (
				options?.triggerTurn === true &&
				((pendingCompactionAdmission !== undefined && pendingCompactionAdmission.outcome !== "completed") ||
					(activeCompactionGeneration !== undefined &&
						this._compactionLifecycle.state.generation === activeCompactionGeneration &&
						this._compactionLifecycle.state.status !== "completed"))
			) {
				if (options?.deliverAs === "followUp") {
					this.agent.followUp(appMessage);
				} else {
					this.agent.steer(appMessage);
				}
			} else if (options?.triggerTurn) {
				try {
					await this._enforceCompactionBeforeProvider(this._findLastAssistantMessage(), false, "pre_prompt");
					await this._enforceFinalProviderAdmission([appMessage]);
				} catch (error) {
					// Mirror sendUserMessage's retention contract: an admission
					// rejection must retain the message for later delivery instead
					// of silently dropping it (the fire-and-forget extension action
					// swallows this rejection).
					if (options.deliverAs === "followUp") {
						this.agent.followUp(appMessage);
					} else {
						this.agent.steer(appMessage);
					}
					throw error;
				}
				await this._promptAgent(appMessage);
			} else {
				this.agent.state.messages.push(appMessage);
				this.sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
				);
				this._incrementMessageRevision();
				this._emit({ type: "message_start", message: appMessage });
				this._emit({ type: "message_end", message: appMessage });
			}
		} finally {
			finishSessionWork?.();
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 * If the prompt path rejects before the message reaches a queue or a turn
	 * (e.g. a required compaction that cannot complete), the message is retained
	 * in the steering/followUp queue for later delivery and the error still propagates.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		const bindingPromptReadiness = this._extensionBindingPromptReadiness;
		let resolveBindingPromptReadiness: (() => void) | undefined;
		if (bindingPromptReadiness) {
			const readiness = new Promise<void>((resolve) => {
				resolveBindingPromptReadiness = resolve;
			});
			bindingPromptReadiness.add(readiness);
		}
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// An extension binding invokes this method fire-and-forget. When it
		// arrives during session work, retain a barrier token after the prior work
		// settles so callers observing session idle cannot race its provider turn.
		const waitForExistingSessionWork = this._sessionWorkBarrier.hasActiveWork;
		let finishSessionWork: (() => void) | undefined;
		let disposition: PromptDisposition | undefined;
		try {
			// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
			await this.prompt(text, {
				expandPromptTemplates: false,
				streamingBehavior: options?.deliverAs,
				images,
				source: "extension",
				promptDisposition: (nextDisposition) => {
					disposition = nextDisposition;
					resolveBindingPromptReadiness?.();
				},
				onSessionWorkReady: waitForExistingSessionWork
					? () => {
							finishSessionWork ??= this._sessionWorkBarrier.begin();
						}
					: undefined,
				sessionTitlePrompt: false,
			});
		} catch (error) {
			// Extension bindings invoke this method fire-and-forget, so a rejection
			// before prompt() accepted the message must not silently drop it.
			if (disposition === undefined) {
				if (options?.deliverAs === "steer") {
					await this._queueSteer(text, images);
				} else {
					await this._queueFollowUp(text, images);
				}
			}
			throw error;
		} finally {
			resolveBindingPromptReadiness?.();
			finishSessionWork?.();
		}
	}

	/** Reserve a global order for input temporarily owned outside the native queues. */
	reserveQueuedInputOrder(): number {
		this._nextQueuedInputOrder += 1;
		return this._nextQueuedInputOrder;
	}

	private _recordQueuedInput(text: string, mode: QueuedInput["mode"], enqueueOrder?: number): void {
		const order = enqueueOrder ?? this.reserveQueuedInputOrder();
		this._nextQueuedInputOrder = Math.max(this._nextQueuedInputOrder, order);
		this._queuedInputOrder.push({ text, mode, enqueueOrder: order });
	}

	private _removeQueuedInput(text: string, mode: QueuedInput["mode"]): void {
		const index = this._queuedInputOrder.findIndex((message) => message.mode === mode && message.text === text);
		if (index !== -1) this._queuedInputOrder.splice(index, 1);
	}

	/**
	 * Clear all queued messages and return them. The non-enumerable `ordered`
	 * view preserves legacy object equality and native queue semantics.
	 * @param options.abortWillFollow Mark a non-empty drain so an immediately following abort can emit session_abort.
	 */
	clearQueue(options: { abortWillFollow: boolean } = { abortWillFollow: false }): ClearedQueue {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		const ordered = [...this._queuedInputOrder].sort((a, b) => a.enqueueOrder - b.enqueueOrder);
		if (options.abortWillFollow && (steering.length > 0 || followUp.length > 0)) {
			this._hadClearedQueuedMessages = true;
		}
		// Clear every queue synchronously. Deferred post-compaction messages are
		// already represented in visible bookkeeping, so they must not be returned
		// a second time or later resurrected into Agent's native queues.
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._queuedInputOrder = [];
		this._postCompactionDeferredSteeringMessages = [];
		this._postCompactionDeferredFollowUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		const cleared = { steering, followUp } as ClearedQueue;
		Object.defineProperty(cleared, "ordered", { value: ordered, enumerable: false });
		return cleared;
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		// Capture gap-state BEFORE _abortActiveAgentAndRetry resets retry/compaction state.
		// A mid-run abort (actively streaming with no pending retry) is delivered via
		// agent_end (abortSource "user") — no session_abort needed. The gap case is when
		// no agent_end will fire to carry the abort signal:
		//   - retry backoff (_retryAbortController defined — the error agent_end already
		//     fired, agent.abort() during backoff is a no-op, no new agent_end)
		//   - compaction (!isStreaming && isCompacting)
		//   - queued continuation that was already cleared by the caller (TUI clears queues
		//     before calling abort, so pendingMessageCount is 0 but _hadClearedQueuedMessages
		//     records that messages were present)
		// Purely-idle defensive aborts (e.g. RPC session close on an idle session) must not
		// fire session_abort.
		const wasMidRun = this.isStreaming && this._retryAbortController === undefined;
		const hadRetryBackoff = this._retryAbortController !== undefined;
		const hadCompactionOrPending = !this.isStreaming && (this.isCompacting || this.pendingMessageCount > 0);
		const hadClearedQueues = this._hadClearedQueuedMessages;
		this._hadClearedQueuedMessages = false;
		const shouldEmitAbort = !wasMidRun && (hadRetryBackoff || hadCompactionOrPending || hadClearedQueues);
		this.abortCompaction();
		await this._abortActiveAgentAndRetry("user");
		if (!shouldEmitAbort) return;
		try {
			await this._extensionRunner.emit({ type: "session_abort" });
			this._emit({ type: "session_abort" });
		} catch {
			// Extension runner may be torn down during RPC close — best-effort.
		}
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: ModelSelectSource,
	): Promise<SystemPromptChangeEvent | undefined> {
		this.syncPromptCacheSafeWaitEnv();
		if (!this._modelSelectionChangesContext(previousModel, nextModel)) return undefined;
		const result = await this._extensionRunner.emitModelSelect({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
			systemPrompt: this.agent.state.systemPrompt,
			systemPromptOptions: this._baseSystemPromptOptions,
		});
		if (result?.systemPrompt === undefined) {
			return undefined;
		}

		const previousSystemPrompt = this.agent.state.systemPrompt;
		const systemPrompt = result.systemPrompt ?? this._baseSystemPrompt;
		if (previousSystemPrompt === systemPrompt) {
			return undefined;
		}

		this.agent.state.systemPrompt = systemPrompt;
		const event: SystemPromptChangeEvent = {
			type: "system_prompt_change",
			systemPrompt,
			previousSystemPrompt,
			model: nextModel,
			previousModel,
			source: "model_select",
		};
		if (result.systemPromptName) {
			event.systemPromptName = result.systemPromptName;
		}
		await this._extensionRunner.emit(event);
		this._emit(event);
		return event;
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<SystemPromptChangeEvent | undefined> {
		return this._setModel(model, true);
	}

	/**
	 * Set the model for this session without changing the global model defaults.
	 * The selection is still persisted in this session's history.
	 */
	async setSessionModel(model: Model<Api>): Promise<SystemPromptChangeEvent | undefined> {
		return this._setModel(model, false);
	}

	private async _setModel(
		model: Model<Api>,
		updateGlobalDefaults: boolean,
	): Promise<SystemPromptChangeEvent | undefined> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		// A manual model change abandons any active fallback window; if a fallback
		// retry sleep is still pending, cancel it so no surprise continuation fires.
		const hadActiveFallback = this._retryFallback.activeState !== undefined;
		this._probeBackScheduler.cancel("manual-model-change");
		this._retryFallback.clearForManualModelChange(model);
		if (hadActiveFallback && this._retryAbortController) {
			this.abortRetry();
		}

		return await this._switchActiveModel(model, {
			persistDefault: updateGlobalDefaults,
			appendSessionEntry: true,
			emitModelSelect: true,
			modelSelectSource: "set",
			invalidateCompaction: true,
		});
	}

	private async _maybeRestoreFallbackPrimary(): Promise<void> {
		try {
			await this._retryFallback.maybeRestorePrimary(this.settingsManager.getRetryFallbackSettings().revertPolicy);
		} catch (error) {
			this._retryFallback.clear();
			console.error("fallback revert failed; cleared fallback state", error);
		}
	}

	private async _switchActiveModel(
		model: Model<Api>,
		opts: {
			persistDefault: boolean;
			appendSessionEntry: boolean;
			entryReason?: "fallback" | "fallback-revert";
			emitModelSelect: boolean;
			modelSelectSource: ModelSelectSource;
			invalidateCompaction: boolean;
			ephemeralThinkingLevel?: ThinkingLevel;
		},
	): Promise<SystemPromptChangeEvent | undefined> {
		const previousModel = this.model;
		if (opts.invalidateCompaction && this._modelSelectionChangesContext(previousModel, model)) {
			this._invalidateCompactionForModelSelection();
		}
		const thinkingLevel = this._getThinkingLevelForModelSwitch(opts.ephemeralThinkingLevel);
		this.agent.state.model = model;
		this.agent.abortServerSideFallback =
			this.settingsManager.getAbortServerSideFallback() && this._retryFallback.hasConfiguredChain();
		if (opts.appendSessionEntry) {
			this.sessionManager.appendModelChange(
				model.provider,
				model.id,
				opts.entryReason,
				previousModel?.provider,
				previousModel?.id,
			);
		}
		if (opts.persistDefault) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}

		const scopedMatch = this._scopedModels.find((sm) => modelsAreEqual(sm.model, model));
		this._currentServiceTier = this._resolveServiceTier(model, scopedMatch?.serviceTier);

		if (opts.ephemeralThinkingLevel !== undefined) {
			this._applyEphemeralThinkingLevel(thinkingLevel);
		} else {
			this.setSessionThinkingLevel(thinkingLevel);
		}

		this._emitHighReasoningWarningIfNeeded();

		if (!opts.emitModelSelect) return undefined;
		return await this._emitModelSelect(model, previousModel, opts.modelSelectSource);
	}

	private _applyEphemeralThinkingLevel(level: ThinkingLevel): void {
		const previousLevel = this.agent.state.thinkingLevel;
		this.agent.state.thinkingLevel = level;
		if (previousLevel !== level) {
			this._emit({ type: "thinking_level_changed", level });
		}
	}

	/**
	 * Cycle to next/previous model.
	 * Uses favorite models, constrained by any global model narrowing.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		const favoriteModels = this._getCurrentFavoriteModels();
		if (favoriteModels.length > 0) {
			return this._cycleFavoriteModel(direction, favoriteModels);
		}
		return undefined;
	}

	private async _cycleFavoriteModel(
		direction: "forward" | "backward",
		favoriteModels: SessionModelEntry[],
	): Promise<ModelCycleResult | undefined> {
		if (favoriteModels.length <= 1) return undefined;

		const currentModel = this.model;
		const currentIndex = favoriteModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		let nextIndex: number;
		if (currentIndex === -1) {
			nextIndex = direction === "forward" ? 0 : favoriteModels.length - 1;
		} else {
			const len = favoriteModels.length;
			nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		}
		const next = favoriteModels[nextIndex];
		const invalidatesCompaction = this._modelSelectionChangesContext(currentModel, next.model);
		if (invalidatesCompaction) {
			this._invalidateCompactionForModelSelection();
		}
		this._probeBackScheduler.cancel("manual-model-change");
		this._retryFallback.clearForManualModelChange(next.model);
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
		this._currentServiceTier = this._resolveServiceTier(next.model, next.serviceTier);

		// Apply thinking level.
		// - Explicit favorite model thinking level overrides the effective session level
		// - Undefined favorite model thinking level restores the remembered user preference
		// setSessionThinkingLevel clamps without replacing that preference.
		this.setSessionThinkingLevel(thinkingLevel);

		const systemPromptChange = await this._emitModelSelect(next.model, currentModel, "cycle");

		const cycleResult: ModelCycleResult = { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
		if (systemPromptChange) {
			cycleResult.systemPromptChange = systemPromptChange;
		}
		return cycleResult;
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		this._setThinkingLevel(level, true);
	}

	/**
	 * Set the thinking level for this session without changing the global default.
	 * The effective level is still persisted in this session's history.
	 */
	setSessionThinkingLevel(level: ThinkingLevel): void {
		this._setThinkingLevel(level, false);
	}

	private _setThinkingLevel(level: ThinkingLevel, updateGlobalDefault: boolean): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;
		if (isChanging) {
			this._retryFallback.noteManualThinkingLevel();
		}

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (updateGlobalDefault && (this.supportsThinking() || effectiveLevel !== "off")) {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
			this._emitHighReasoningWarningIfNeeded();
		}
	}

	private _emitHighReasoningWarningIfNeeded(): void {
		const model = this.model;
		const level = this.thinkingLevel;
		if (!model || !shouldWarnHighReasoning(model, level)) return;
		const key = `${model.provider}/${model.id}`;
		if (this._shownHighReasoningWarningKeys.has(key)) return;
		this._shownHighReasoningWarningKeys.add(key);
		this._emit({
			type: "high_reasoning_warning",
			modelId: model.id,
			provider: model.provider,
			thinkingLevel: level,
		});
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.model;
		return model ? (getSupportedThinkingLevels(model) as ThinkingLevel[]) : ["off"];
	}

	/**
	 * Check if current model supports xhigh thinking level.
	 */
	supportsXhighThinking(): boolean {
		return this.model ? supportsXhigh(this.model) : false;
	}

	/**
	 * Check if current model exposes the native "max" adaptive thinking tier
	 * (currently Anthropic Opus 4.6 legacy and Opus 4.7 native).
	 */
	supportsMaxThinking(): boolean {
		return this.model ? supportsMax(this.model) : false;
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel {
		const available = new Set(availableLevels);
		const requestedIndex = THINKING_LEVELS_WITH_MAX.indexOf(level);
		if (requestedIndex === -1) return availableLevels[0] ?? "off";

		for (let index = requestedIndex; index < THINKING_LEVELS_WITH_MAX.length; index++) {
			const candidate = THINKING_LEVELS_WITH_MAX[index];
			if (candidate && available.has(candidate)) return candidate;
		}
		for (let index = requestedIndex - 1; index >= 0; index--) {
			const candidate = THINKING_LEVELS_WITH_MAX[index];
			if (candidate && available.has(candidate)) return candidate;
		}
		return availableLevels[0] ?? "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	private _claimCompactionController(controller: AbortController, owner: "auto" | "compaction"): void {
		const supersedesCurrentOperation =
			(this._compactionAbortController !== undefined && this._compactionAbortController !== controller) ||
			(this._autoCompactionAbortController !== undefined && this._autoCompactionAbortController !== controller);
		if (supersedesCurrentOperation) {
			// Supersession has no public terminal event: the stale operation no
			// longer owns the route. Finishing its lifecycle state here prevents a
			// missing late feedback end from keeping isCompacting true.
			this._compactionLifecycle.abort(this._messageRevision);
		}
		if (this._compactionAbortController && this._compactionAbortController !== controller) {
			this._compactionAbortController.abort();
			this._compactionAbortController = undefined;
		}
		if (this._autoCompactionAbortController && this._autoCompactionAbortController !== controller) {
			this._autoCompactionAbortController.abort();
			this._autoCompactionAbortController = undefined;
		}
		if (owner === "auto") {
			this._autoCompactionAbortController = controller;
		} else {
			this._compactionAbortController = controller;
		}
	}

	private _ownsCompactionController(controller: AbortController, owner: "auto" | "compaction"): boolean {
		return (
			!controller.signal.aborted &&
			(owner === "auto"
				? this._autoCompactionAbortController === controller
				: this._compactionAbortController === controller)
		);
	}

	private _releaseCompactionController(signal: AbortSignal): void {
		if (this._compactionAbortController?.signal === signal) {
			this._compactionAbortController = undefined;
		}
		if (this._autoCompactionAbortController?.signal === signal) {
			this._autoCompactionAbortController = undefined;
		}
	}

	private _claimPendingCompactionAdmission(): PendingCompactionAdmission {
		const priorAdmission = this._pendingCompactionAdmission;
		if (priorAdmission) {
			priorAdmission.controller.abort();
			priorAdmission.outcome = "aborted";
			priorAdmission.finishSessionWork();
		}

		const controller = new AbortController();
		const admission: PendingCompactionAdmission = {
			controller,
			finishSessionWork: this._sessionWorkBarrier.begin(),
		};
		this._pendingCompactionAdmission = admission;
		this._claimCompactionController(controller, "compaction");
		return admission;
	}

	private _releasePendingCompactionAdmission(
		admission: PendingCompactionAdmission,
		outcome: "completed" | "failed" | "aborted",
	): void {
		admission.outcome = outcome;
		if (this._pendingCompactionAdmission !== admission) return;
		this._pendingCompactionAdmission = undefined;
		admission.finishSessionWork();
	}

	private async _abortActiveAgentAndRetry(source: "user" | "system"): Promise<void> {
		this.abortRetry();
		this.abortBranchSummary();
		if (this._userAbortPromise) {
			this.agent.abort();
			await this._userAbortPromise;
			return;
		}
		if (this.isStreaming) {
			this._suppressQueuedContinuationAfterUserAbort = true;
			this._agentAbortSource = source;
		}

		const abortPromise = (async () => {
			this.agent.abort();
			await this.waitForIdle();
		})();
		this._userAbortPromise = abortPromise;
		try {
			await abortPromise;
		} finally {
			if (this._userAbortPromise === abortPromise) {
				this._userAbortPromise = undefined;
			}
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const admission = this._claimPendingCompactionAdmission();
		const controller = admission.controller;
		const requestId = randomUUID();
		let outcome: "completed" | "failed" | "aborted" = "failed";
		let disconnected = false;

		try {
			// Keep the session subscriber attached until the aborted run emits
			// agent_end. That event clears the active-run and retry state that
			// waitForIdle() depends on.
			await this._abortActiveAgentAndRetry("system");
			this._disconnectFromAgent();
			disconnected = true;
			this._emit({ type: "compaction_start", reason: "manual", requestId });
			const execution = await this._executeCompaction({
				controller,
				owner: "compaction",
				reason: "manual",
				requestId,
				customInstructions,
				willRetry: false,
			});
			if (!execution.accepted) {
				throw new CompactionRejectedError(execution.rejectionCause);
			}
			outcome = "completed";
			return execution.result;
		} catch (error) {
			outcome = isCompactionExecutionAborted(error) ? "aborted" : "failed";
			if (error instanceof CompactionRejectedError) {
				throw new Error(error.message);
			}
			if (!compactionExecutionOwnsTerminalTransition(error)) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			const aborted = isCompactionExecutionAborted(error);
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				requestId,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			if (this._compactionAbortController === controller && this._compactionLifecycle.state.status !== "running") {
				this._compactionAbortController = undefined;
			}
			this._releasePendingCompactionAdmission(admission, outcome);
			if (disconnected && !this.isCompacting) this._reconnectToAgent();
			if (outcome === "completed") this._resumeQueuedMessagesAfterCompaction();
		}
	}

	async applyCompaction(
		precomputed: CompactionResult,
		options: ApplyCompactionOptions,
	): Promise<ApplyCompactionResult> {
		if (options.signal !== undefined && options.signal !== this._compactionAbortController?.signal) {
			return { applied: false, reason: "stale" };
		}
		if (options.expectedRevision !== undefined && options.expectedRevision !== this._messageRevision) {
			return { applied: false, reason: "stale" };
		}

		const ownsController = this._compactionAbortController === undefined;
		const lifecycleState = this._compactionLifecycle.state;
		const requestId =
			!ownsController && lifecycleState.status === "running" && lifecycleState.stage === "feedback"
				? lifecycleState.operationId
				: randomUUID();
		if (ownsController) {
			this._claimCompactionController(new AbortController(), "compaction");
			this._emit({ type: "compaction_start", reason: options.reason, requestId });
		}
		const controller = this._compactionAbortController;
		if (!controller) return { applied: false, reason: "rejected" };
		this._claimCompactionController(controller, "compaction");

		try {
			const execution = await this._executeCompaction({
				controller,
				owner: "compaction",
				reason: options.reason,
				requestId,
				willRetry: false,
				precomputed,
			});
			if (!execution.accepted) {
				return { applied: false, reason: "rejected" };
			}
			this._resumeQueuedMessagesAfterCompaction();
			return { applied: true, reason: "ok" };
		} catch (error) {
			if (!compactionExecutionOwnsTerminalTransition(error)) {
				return { applied: false, reason: "rejected" };
			}
			const message = error instanceof Error ? error.message : String(error);
			const aborted = isCompactionExecutionAborted(error);
			this._emit({
				type: "compaction_end",
				reason: options.reason,
				result: undefined,
				aborted,
				willRetry: false,
				requestId,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			return { applied: false, reason: "rejected" };
		} finally {
			if (this._compactionAbortController === controller && this._compactionLifecycle.state.status !== "running") {
				this._compactionAbortController = undefined;
			}
		}
	}

	private _beginExtensionCompactionFeedback(reason: CompactionReason): AbortSignal {
		const controller = new AbortController();
		this._claimCompactionController(controller, "compaction");
		const model = this.model;
		const requestId = randomUUID();
		this._compactionLifecycle.begin(
			{
				operationId: requestId,
				stage: "feedback",
				reason,
				model: model ? { provider: model.provider, id: model.id } : undefined,
				startedRevision: this._messageRevision,
			},
			controller,
		);
		this._emit({ type: "compaction_start", reason, requestId });
		return controller.signal;
	}

	private _updateExtensionCompactionFeedback(options: {
		reason: CompactionReason;
		signal?: AbortSignal;
		delta?: string;
		text?: string;
	}): void {
		if (!options.signal || !this._compactionLifecycle.hasCurrentSignal(options.signal)) return;
		this._emit({
			type: "compaction_progress",
			reason: options.reason,
			...(options.delta !== undefined ? { delta: options.delta } : {}),
			...(options.text !== undefined ? { text: options.text } : {}),
		});
	}

	private _endExtensionCompactionFeedback(options: {
		reason: CompactionReason;
		signal?: AbortSignal;
		aborted?: boolean;
		errorMessage?: string;
	}): void {
		if (!options.signal) return;
		if (!this._compactionLifecycle.hasCurrentSignal(options.signal)) {
			this._releaseCompactionController(options.signal);
			return;
		}
		const operation = this._compactionLifecycle.state;
		if (operation.status !== "running" || operation.stage !== "feedback") return;
		const aborted = options.aborted ?? options.signal.aborted;
		this._compactionLifecycle.finish({
			operationId: operation.operationId,
			status: aborted ? "aborted" : "failed",
			endedRevision: this._messageRevision,
			...(aborted
				? { errorMessage: "Compaction cancelled" }
				: { errorMessage: options.errorMessage ?? "Compaction did not apply" }),
		});
		this._emit({
			type: "compaction_end",
			reason: options.reason,
			result: undefined,
			aborted,
			willRetry: false,
			requestId: operation.operationId,
			errorMessage: aborted ? undefined : (options.errorMessage ?? "Compaction did not apply"),
		});
		this._releaseCompactionController(options.signal);
	}

	private async _executeCompaction(request: CompactionExecutionRequest): Promise<CompactionExecutionResult> {
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
		const thinkingLevel = this.thinkingLevel;
		const controller = request.controller;
		// Async auth and provider preparation may yield to a newer route. A stale
		// controller must never promote itself into a lifecycle generation.
		if (!this._ownsCompactionController(controller, request.owner)) {
			throw new CompactionExecutionError(new CompactionCancelledError(), false, true);
		}
		const requestId = request.requestId ?? randomUUID();
		const operationId = this._compactionLifecycle.begin(
			{
				operationId: requestId,
				stage: "execution",
				reason: request.reason,
				model: { provider: model.provider, id: model.id },
				startedRevision: this._messageRevision,
			},
			controller,
		);
		const finishCompactionWork = this._sessionWorkBarrier.begin();
		const agentMessagesAtStart = request.agentMessagesAtStart ?? this.agent.state.messages.slice();
		const compactionOwnedDiagnosticMessages = new Set<AgentMessage>();
		const signal = controller.signal;
		try {
			if (signal.aborted) {
				throw new CompactionCancelledError();
			}
			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			let compactionResult = request.precomputed;
			let fromExtension = request.precomputed !== undefined;

			if (!compactionResult) {
				const preparation = prepareCompaction(
					pathEntries,
					settings,
					request.reason === "overflow",
					request.allowSummaryOnly,
				);

				if (!preparation) {
					const lastEntry = pathEntries[pathEntries.length - 1];
					if (lastEntry?.type === "compaction") {
						throw new Error("Already compacted");
					}
					throw new Error("Nothing to compact (session too small)");
				}

				if (this._extensionRunner.hasHandlers("session_before_compact")) {
					const messagesBeforeExtension = new Set(this.agent.state.messages);
					const extensionResult = (await this._extensionRunner.emit({
						type: "session_before_compact",
						reason: request.reason,
						willRetry: request.willRetry,
						requestId,
						preparation,
						branchEntries: pathEntries,
						customInstructions: request.customInstructions,
						signal,
					})) as SessionBeforeCompactResult | undefined;
					for (const message of this.agent.state.messages) {
						if (
							!messagesBeforeExtension.has(message) &&
							isCompactionOwnedPreCompactDiagnostic(message, requestId)
						) {
							compactionOwnedDiagnosticMessages.add(message);
						}
					}

					if (!this._compactionLifecycle.isCurrent(operationId, controller)) {
						throw new CompactionCancelledError();
					}

					if (extensionResult?.cancel) {
						return await this._rejectCompaction(
							request,
							requestId,
							operationId,
							extensionResult.rejectionCause ?? "cancelled-by-extension",
							true,
							extensionResult.reason,
						);
					}

					if (extensionResult?.compaction) {
						compactionResult = extensionResult.compaction;
						fromExtension = true;
					}
				}

				if (!compactionResult) {
					const { apiKey, headers, extraBody, env } = await this._getCompactionRequestAuth(model);
					compactionResult = await compact(
						preparation,
						model,
						apiKey,
						headers,
						request.customInstructions,
						signal,
						extraBody,
						thinkingLevel,
						this.agent.streamFunction,
						env,
						this.agent.transformContext,
						this.settingsManager.getRetrySettings(),
						this._summarizationRetryCallbacks({ source: "compaction", reason: request.reason }),
						this.sessionManager.getSessionId(),
					);
				}
			}

			if (signal.aborted) {
				throw new CompactionCancelledError();
			}
			if (!this._compactionLifecycle.isCurrent(operationId, controller)) {
				throw new CompactionCancelledError();
			}

			const lifecycleState = this._compactionLifecycle.state;
			const currentMessagesAtCheck = this.agent.state.messages;
			const startPrefixIntact = agentMessagesAtStart.every(
				(message, index) => currentMessagesAtCheck[index] === message,
			);
			// Appends after the start snapshot are fresh only while they are exact
			// message_end identities still awaiting persistence. Any revision change,
			// other append, replacement, or reorder still makes this compaction stale.
			const onlyPendingPersistenceAppends =
				startPrefixIntact &&
				currentMessagesAtCheck
					.slice(agentMessagesAtStart.length)
					.every(
						(message) =>
							this._messageEndsAwaitingPersistence.has(message) ||
							compactionOwnedDiagnosticMessages.has(message),
					);
			const sourceChanged =
				lifecycleState.status !== "running" ||
				lifecycleState.operationId !== operationId ||
				lifecycleState.startedRevision + compactionOwnedDiagnosticMessages.size !== this._messageRevision ||
				!onlyPendingPersistenceAppends;
			if (sourceChanged) {
				return await this._rejectCompaction(request, requestId, operationId, "stale-revision", false);
			}

			if (this._wouldCompactionOverflow(pathEntries, compactionResult, fromExtension, model)) {
				return await this._rejectCompaction(request, requestId, operationId, "would-overflow", false);
			}

			const compactionEntryId = this.sessionManager.appendCompaction(
				compactionResult.summary,
				compactionResult.firstKeptEntryId,
				compactionResult.tokensBefore,
				compactionResult.details,
				fromExtension,
				compactionResult.usage,
			);
			const savedEntry = this.sessionManager.getEntry(compactionEntryId);
			if (savedEntry?.type !== "compaction") {
				throw new Error("Compaction entry was not saved");
			}

			const sessionContext = this.sessionManager.buildSessionContext();
			const currentAgentMessages = this.agent.state.messages;
			const hasUnchangedPrefix = agentMessagesAtStart.every(
				(message, index) => currentAgentMessages[index] === message,
			);
			const messagesAppendedDuringCompaction = hasUnchangedPrefix
				? currentAgentMessages.slice(agentMessagesAtStart.length)
				: [];
			// Preserve an identity-deduped, agent-ordered union of the append-during-
			// compaction suffix and exact messages still awaiting persistence. Their
			// queued message_end owns exactly-once persistence, so they are kept in
			// agent state only and never persisted here.
			const preservedIdentities = new Set<AgentMessage>(messagesAppendedDuringCompaction);
			for (const message of currentAgentMessages) {
				if (this._messageEndsAwaitingPersistence.has(message)) {
					preservedIdentities.add(message);
				}
			}
			const preservedPendingMessages = currentAgentMessages.filter((message) => preservedIdentities.delete(message));
			this._skipNextPostCompactionAssistantCheck = true;
			for (const message of preservedPendingMessages) {
				if (message.role === "assistant") {
					this._assistantsPendingAtCompaction.add(message);
				}
			}
			this.agent.state.messages = [...sessionContext.messages, ...preservedPendingMessages];
			compactionResult.estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);
			this._incrementMessageRevision();
			if (
				!this._compactionLifecycle.finish({
					operationId,
					status: "completed",
					endedRevision: this._messageRevision,
				})
			) {
				throw new CompactionCancelledError();
			}

			this._emit({
				type: "compaction_end",
				reason: request.reason,
				result: compactionResult,
				aborted: false,
				willRetry: request.willRetry,
				requestId,
				accepted: true,
			});

			await this._extensionRunner.emit({
				type: "session_compact",
				reason: request.reason,
				requestId,
				accepted: true,
				compactionEntry: savedEntry,
				fromExtension,
				willRetry: request.willRetry,
			});

			return { accepted: true, requestId, result: compactionResult, compactionEntry: savedEntry, fromExtension };
		} catch (error) {
			if (error instanceof CompactionExecutionError) {
				throw error;
			}
			const lifecycleState = this._compactionLifecycle.state;
			const ownsTerminalTransition = lifecycleState.status !== "idle" && lifecycleState.operationId === operationId;
			const aborted = signal.aborted || isCompactionExecutionAborted(error);
			if (ownsTerminalTransition && lifecycleState.status === "running") {
				this._compactionLifecycle.finish({
					operationId,
					status: aborted ? "aborted" : "failed",
					endedRevision: this._messageRevision,
					errorMessage: error instanceof Error ? error.message : String(error),
				});
			}
			throw new CompactionExecutionError(error, ownsTerminalTransition, aborted);
		} finally {
			finishCompactionWork();
		}
	}

	private _wouldCompactionOverflow(
		pathEntries: SessionEntry[],
		compactionResult: CompactionResult,
		fromExtension: boolean,
		model: Model<Api>,
	): boolean {
		const currentLeaf = pathEntries[pathEntries.length - 1];
		if (!currentLeaf) return false;

		const simulatedCompactionEntry: CompactionEntry = {
			type: "compaction",
			id: `simulated-${randomUUID()}`,
			parentId: currentLeaf.id,
			timestamp: new Date().toISOString(),
			summary: compactionResult.summary,
			firstKeptEntryId: compactionResult.firstKeptEntryId,
			tokensBefore: compactionResult.tokensBefore,
			details: compactionResult.details,
			fromHook: fromExtension,
		};

		const simulatedMessages = buildSessionContext(
			[...pathEntries, simulatedCompactionEntry],
			simulatedCompactionEntry.id,
		).messages;
		const contextTokens = estimateMessagesTokens(filterContextExcludedMessages(simulatedMessages));
		const settings = this.settingsManager.getCompactionSettings();
		return contextTokens > model.contextWindow - settings.reserveTokens;
	}

	/**
	 * Replaces agent state with the canonical session context while keeping exact
	 * message objects whose message_end persistence is still queued. Identities
	 * already present in the session context are kept from the context only, so
	 * nothing is duplicated; the queued message_end still owns exactly-once
	 * persistence for the rest.
	 */
	private _restoreAgentMessagesFromSession(): void {
		const sessionMessages = this.sessionManager.buildSessionContext().messages;
		const seen = new Set<AgentMessage>(sessionMessages);
		const pendingMessages: AgentMessage[] = [];
		for (const message of this.agent.state.messages) {
			if (seen.has(message) || !this._messageEndsAwaitingPersistence.has(message)) continue;
			seen.add(message);
			pendingMessages.push(message);
		}
		this.agent.state.messages = [...sessionMessages, ...pendingMessages];
	}

	private async _rejectCompaction(
		request: CompactionExecutionRequest,
		requestId: string,
		operationId: string,
		rejectionCause: CompactionRejectionCause,
		aborted: boolean,
		extensionReason?: string,
	): Promise<CompactionExecutionResult> {
		// Per plan Section 1: rejection must never be silent. The compaction_end event
		// carries a non-empty human-readable errorMessage (unless the user aborted, where
		// the aborted branch already renders "Compaction cancelled"). session_compact is
		// also emitted with accepted:false so the compaction extension's circuit-breaker
		// bookkeeping stops being dead code; other builtin session_compact handlers guard
		// on event.accepted.
		const trimmedExtensionReason = extensionReason?.trim();
		const detailedMessage = trimmedExtensionReason
			? `Compaction rejected: ${trimmedExtensionReason}`
			: describeCompactionRejection(rejectionCause);
		const errorMessage = aborted && !trimmedExtensionReason ? undefined : detailedMessage;
		if (
			!this._compactionLifecycle.finish({
				operationId,
				status: "failed",
				endedRevision: this._messageRevision,
				rejectionCause,
				...(trimmedExtensionReason !== undefined ? { errorMessage: trimmedExtensionReason } : {}),
			})
		) {
			throw new CompactionCancelledError();
		}
		this._emit({
			type: "compaction_end",
			reason: request.reason,
			result: undefined,
			aborted,
			willRetry: false,
			requestId,
			accepted: false,
			rejectionCause,
			errorMessage,
		});
		await this._extensionRunner.emit({
			type: "session_compact",
			reason: request.reason,
			requestId,
			accepted: false,
			rejectionCause,
			fromExtension: false,
			willRetry: false,
		});
		return { accepted: false, requestId, rejectionCause };
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		const lifecycleState = this._compactionLifecycle.state;
		const activeFeedbackRequestId =
			lifecycleState.status === "running" && lifecycleState.stage === "feedback"
				? lifecycleState.operationId
				: undefined;
		const feedbackOperation = this._compactionLifecycle.abort(this._messageRevision);
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
		if (feedbackOperation?.stage === "feedback") {
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: feedbackOperation.reason,
				result: undefined,
				aborted: true,
				willRetry: false,
				requestId: activeFeedbackRequestId,
			});
		}
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _enforceCompactionBeforeProvider(
		assistantMessage: AssistantMessage | undefined,
		skipAbortedCheck: boolean,
		inlineReason: "pre_prompt" | "threshold",
		retryAfterCompaction = false,
	): Promise<boolean> {
		const blockedAdmission = this._blockedPostCompactionAssistant;
		if (
			blockedAdmission !== undefined &&
			blockedAdmission.assistant === assistantMessage &&
			blockedAdmission.revision === this._messageRevision
		) {
			throw new RequiredCompactionError();
		}

		const settings = this.settingsManager.getCompactionSettings();
		const model = this.model;
		const contextTokens = estimateContextTokens(
			filterContextExcludedMessages(this.sessionManager.buildSessionContext().messages),
		).tokens;
		const compacted = assistantMessage
			? await this._checkCompaction(assistantMessage, skipAbortedCheck, inlineReason, retryAfterCompaction)
			: false;
		if (compacted || (assistantMessage && this._postCompactionUsageExemptAssistants.has(assistantMessage))) {
			return compacted;
		}

		if (!settings.enabled || !model || !shouldCompact(contextTokens, model.contextWindow, settings)) {
			return false;
		}

		const latestCompaction = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantBeforeLatestCompaction =
			assistantMessage !== undefined && this._isAssistantFromBeforeLatestCompaction(assistantMessage);
		const hasPostCompactionCustomState =
			latestCompaction !== null &&
			this.agent.state.messages.some(
				(message) =>
					message.role === "custom" && message.timestamp >= new Date(latestCompaction.timestamp).getTime(),
			);
		if (assistantBeforeLatestCompaction && !hasPostCompactionCustomState) {
			return false;
		}
		if (assistantBeforeLatestCompaction && assistantMessage) {
			const compacted = await this._runPrePromptCompaction(assistantMessage, skipAbortedCheck, inlineReason);
			if (compacted) return true;
		}
		if (this._isCompactionOnCooldown()) return false;
		throw new RequiredCompactionError();
	}

	/**
	 * The normal pre-prompt check only estimates persisted session context. This
	 * final gate also includes turn-local messages which the provider will see:
	 * the current prompt, next-turn custom messages, and before_agent_start
	 * additions. Compaction rewrites only session context, so callers retain and
	 * reapply their already-assembled one-shot additions after it succeeds.
	 */
	private async _enforceFinalProviderAdmission(messages: readonly AgentMessage[]): Promise<void> {
		// Normal user-only prompts keep the established provider-overflow recovery
		// path. This final gate closes the separate gap introduced by turn-local
		// custom additions, which the normal pre-prompt check cannot observe.
		if (!messages.some((message) => message.role === "custom")) return;

		const model = this.model;
		if (!model) return;
		const settings = this.settingsManager.getCompactionSettings();
		const isOversized = (): boolean => {
			const providerMessages = filterContextExcludedMessages([...this.agent.state.messages, ...messages]);
			const estimate = estimateContextTokens(providerMessages);
			const usageMessage = estimate.lastUsageIndex === null ? undefined : providerMessages[estimate.lastUsageIndex];
			// Kept assistant usage can describe the pre-compaction request. Once a
			// compaction boundary exists, fall back to byte-derived message estimates
			// until a provider response refreshes that usage.
			const contextTokens =
				usageMessage?.role === "assistant" && this._isAssistantFromBeforeLatestCompaction(usageMessage)
					? estimateMessagesTokens(providerMessages)
					: estimate.tokens;
			return contextTokens > model.contextWindow - settings.reserveTokens;
		};

		if (!settings.enabled || !isOversized()) return;

		const lastAssistantMessage = this._findLastAssistantMessage();
		if (!lastAssistantMessage) {
			throw new RequiredCompactionError();
		}

		const compacted = await this._runPrePromptCompaction(lastAssistantMessage, false, "pre_prompt");
		if (!compacted && !isOversized() && this._isCompactionOnCooldown()) return;
		if (!compacted || isOversized()) {
			throw new RequiredCompactionError();
		}
	}

	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		inlineReason?: "pre_prompt" | "threshold",
		retryAfterCompaction = false,
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model &&
			isSameOverflowSource(
				assistantMessage,
				this.model,
				this._modelRuntime.getCompatibilityRequestConfig(this.model).upstreamModelId,
			);

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (this._isAssistantFromBeforeLatestCompaction(assistantMessage)) {
			return false;
		}
		// Case 1: Overflow - LLM returned context overflow error.
		// If the saved assistant provider differs from the currently selected provider alias,
		// still recover as overflow when the current context is also at the compaction limit.
		const contextUsage = this.getContextUsage();
		const currentContextNeedsCompaction =
			contextUsage !== undefined &&
			contextUsage.tokens !== null &&
			shouldCompact(contextUsage.tokens, contextUsage.contextWindow, settings);
		const isOverflow =
			isContextOverflow(assistantMessage, contextWindow) && (sameModel || currentContextNeedsCompaction);
		if (
			isOverflow &&
			assistantMessage.stopReason === "stop" &&
			this._consumePostCompactionUsageExemption(assistantMessage)
		) {
			return false;
		}
		if (isOverflow) {
			this._flushPostCompactionDeferredMessages();
			const willRetry = retryAfterCompaction || assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				const compacted = await this._runAutoCompaction("overflow", false);
				if (
					!compacted &&
					this._compactionLifecycle.state.status === "failed" &&
					getLatestCompactionEntry(this.sessionManager.getBranch()) !== null
				) {
					this._blockedPostCompactionAssistant = {
						assistant: assistantMessage,
						revision: this._messageRevision,
					};
				}
				return compacted;
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage =
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				if (inlineReason === "pre_prompt") {
					throw new Error(errorMessage);
				}
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			let removedOverflowAssistant = false;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
				removedOverflowAssistant = true;
				this._incrementMessageRevision();
			}
			const compacted = inlineReason
				? await this._runPrePromptCompaction(assistantMessage, skipAbortedCheck, "overflow", willRetry)
				: await this._runAutoCompaction("overflow", willRetry);
			if (!compacted && removedOverflowAssistant) {
				this._restoreAgentMessagesFromSession();
				this._incrementMessageRevision();
			}
			if (!compacted && inlineReason) {
				throw new RequiredCompactionError();
			}
			return compacted;
		}

		// The first ordinary response can carry provider usage calculated before
		// compaction. Consume that exemption only after proving this is not an
		// overflow, then retain the decision for later admission re-sampling.
		if (this._consumePostCompactionUsageExemption(assistantMessage)) return false;

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		if (inlineReason) {
			const messages = filterContextExcludedMessages(this.sessionManager.buildSessionContext().messages);
			contextTokens = estimateContextTokens(messages).tokens;
		} else {
			const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
			if (assistantMessage.stopReason !== "error" && directContextTokens !== 0) {
				contextTokens = directContextTokens;
			} else {
				const messages = filterContextExcludedMessages(this.agent.state.messages);
				const estimate = estimateContextTokens(messages);
				if (estimate.lastUsageIndex === null) {
					if (!this._isRequiredCompactionError(assistantMessage)) return false;
				} else {
					// Verify the usage source is post-compaction. Kept pre-compaction messages
					// have stale usage reflecting the old (larger) context and would falsely
					// trigger compaction right after one just finished.
					const usageMsg = messages[estimate.lastUsageIndex];
					if (
						compactionEntry &&
						usageMsg.role === "assistant" &&
						this._isAssistantFromBeforeLatestCompaction(usageMsg)
					) {
						return false;
					}
				}
				contextTokens = estimate.tokens;
			}
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			if (inlineReason) {
				return await this._runPrePromptCompaction(
					assistantMessage,
					skipAbortedCheck,
					inlineReason,
					retryAfterCompaction,
				);
			} else {
				const compacted = await this._runAutoCompaction("threshold", retryAfterCompaction);
				if (
					!compacted &&
					this._compactionLifecycle.state.status === "failed" &&
					getLatestCompactionEntry(this.sessionManager.getBranch()) !== null
				) {
					this._blockedPostCompactionAssistant = {
						assistant: assistantMessage,
						revision: this._messageRevision,
					};
				}
				return compacted;
			}
		}
		return false;
	}

	private _isCompactionOnCooldown(): boolean {
		const state = this._compactionLifecycle.state;
		return state.status === "failed" && state.rejectionCause === "circuit-breaker";
	}

	private async _runPrePromptCompaction(
		lastAssistantMessage: AssistantMessage | undefined,
		skipAbortedCheck: boolean,
		reason: "pre_prompt" | "overflow" | "threshold" = "pre_prompt",
		willRetry = false,
		allowSummaryOnly = false,
	): Promise<boolean> {
		const controller = new AbortController();
		const requestId = randomUUID();
		this._claimCompactionController(controller, "compaction");
		this._emit({ type: "compaction_start", reason, requestId });

		try {
			const execution = await this._executeCompaction({
				controller,
				owner: "compaction",
				reason,
				requestId,
				willRetry,
				lastAssistantMessage,
				skipAbortedCheck,
				allowSummaryOnly,
			});
			if (
				!execution.accepted &&
				lastAssistantMessage &&
				isContextOverflow(lastAssistantMessage, this.model?.contextWindow ?? 0)
			) {
				this._overflowRecoveryAttempted = false;
			}
			return execution.accepted;
		} catch (error) {
			if (!compactionExecutionOwnsTerminalTransition(error)) {
				return false;
			}
			if (lastAssistantMessage && isContextOverflow(lastAssistantMessage, this.model?.contextWindow ?? 0)) {
				this._overflowRecoveryAttempted = false;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted = isCompactionExecutionAborted(error);
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted,
				willRetry: false,
				requestId,
				errorMessage: aborted ? undefined : `Pre-prompt compaction failed: ${errorMessage}`,
			});
			return false;
		} finally {
			if (this._compactionAbortController === controller && this._compactionLifecycle.state.status !== "running") {
				this._compactionAbortController = undefined;
			}
		}
	}

	private async _revalidateScheduledContinuationAdmission(): Promise<void> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings();
		if (!model || !settings.enabled) return;

		const canonicalMessages = filterContextExcludedMessages(this.sessionManager.buildSessionContext().messages);
		const estimate = estimateContextTokens(canonicalMessages);
		const usageMessage = estimate.lastUsageIndex === null ? undefined : canonicalMessages[estimate.lastUsageIndex];
		const contextTokens =
			usageMessage?.role === "assistant" && this._isAssistantFromBeforeLatestCompaction(usageMessage)
				? estimateMessagesTokens(canonicalMessages)
				: estimate.tokens;
		if (!shouldCompact(contextTokens, model.contextWindow, settings)) return;

		const compacted = await this._runPrePromptCompaction(this._findLastAssistantMessage(), true, "pre_prompt");
		if (!compacted) {
			if (this._isCompactionOnCooldown()) return;
			throw new RequiredCompactionError();
		}
		this._scheduledContinuationRecompacted = true;
	}

	private async _continueAgentAfterCurrentRun(
		options: AgentContinuationOptions = {},
		retryTimeoutMs?: number,
	): Promise<"continued" | "taken-over"> {
		await this.agent.waitForIdle();
		try {
			if (this.agent.state.isStreaming) return "taken-over";

			await this._revalidateScheduledContinuationAdmission();
			if (this.agent.state.isStreaming) return "taken-over";

			await runBoundedRetryContinuation({
				continueRun: async () => {
					if (this._scheduledContinuationRecompacted) {
						const tail = this.agent.state.messages.at(-1);
						if (tail?.role === "assistant" && (tail.stopReason === "error" || tail.stopReason === "aborted")) {
							this._retireFailedRetryAssistant(tail);
							if (this.agent.state.messages.at(-1) === tail) {
								this.agent.state.messages = this.agent.state.messages.slice(0, -1);
								this._incrementMessageRevision();
							}
						}
						await this.agent.continueWithQueuedMessages(options);
					} else {
						await this.agent.continue(options);
					}
				},
				getActiveSignal: () => this.agent.signal,
				abortActive: () => this.agent.abort(),
				timeoutMs: retryTimeoutMs,
			});
			return "continued";
		} catch (error) {
			if (
				this.agent.state.isStreaming &&
				error instanceof Error &&
				error.message.startsWith("Agent is already processing")
			) {
				return "taken-over";
			}
			throw error;
		} finally {
			this._scheduledContinuationRecompacted = false;
		}
	}

	/**
	 * Mirror _runAutoCompaction's post-success recovery for non-auto compaction
	 * owners (manual, extension action, extension apply): a custom triggerTurn
	 * message sent while the compaction was running is parked in the agent-level
	 * queues without starting a turn, so a settled compaction must deliver it or
	 * hidden continuations (e.g. goal) wedge until manual user input.
	 */
	private _resumeQueuedMessagesAfterCompaction(): void {
		if (this.pendingMessageCount > 0 || this.agent.hasQueuedMessages()) {
			this._scheduleContinuationAfterCurrentEvent();
		}
	}

	private _scheduleContinuationAfterCurrentEvent(
		options: AgentContinuationOptions = {},
		retryContinuation = false,
		retryTimeoutMs?: number,
	): void {
		// Tool hooks wait for queued message persistence, so continue() cannot run inside this event promise.
		const currentEventQueue = this._agentEventQueue;
		const finishContinuationWork = this._sessionWorkBarrier.begin();
		const continueAfterEvent = async (): Promise<void> => {
			try {
				await this._continueAgentAfterCurrentRun(options, retryTimeoutMs);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this._emit({
					type: "continuation_error",
					errorMessage: `Failed to continue queued messages: ${message}`,
				});
				if (!this.agent.state.isStreaming) {
					await this._emitAgentSettled();
				}
				if (retryContinuation) this._resolveRetry();
			}
		};

		void currentEventQueue
			.then(continueAfterEvent, continueAfterEvent)
			.finally(finishContinuationWork)
			.catch(() => undefined);
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const finishCompactionWork = this._sessionWorkBarrier.begin();
		const agentMessagesAtStart = this.agent.state.messages.slice();
		const autoCompactionController = new AbortController();
		const requestId = randomUUID();
		this._claimCompactionController(autoCompactionController, "auto");
		const endBeforeExecution = (): false => {
			this._emit({ type: "compaction_start", reason, requestId });
			if (reason === "overflow" && this._autoCompactionAbortController === autoCompactionController) {
				this._overflowRecoveryAttempted = false;
			}
			// A synchronous compaction_start listener can supersede this controller with a new
			// operation, which then owns its own start/end lifecycle; publishing another terminal
			// event here would be stale. A listener can instead abort this very controller, and
			// that still needs a terminal event: consumers open UI state on compaction_start and
			// close it only on compaction_end.
			if (this._autoCompactionAbortController !== autoCompactionController) return false;
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: autoCompactionController.signal.aborted,
				willRetry: false,
				requestId,
			});
			return false;
		};

		try {
			if (!this.model) {
				return endBeforeExecution();
			}

			try {
				// Resolve once before admission so a pending auth refresh remains a
				// cancellable boundary. _executeCompaction resolves the policy-specific
				// auth after extension compaction hooks have had a chance to provide a
				// summary without credentials.
				await this._modelRuntime.getAuth(this.model);
			} catch {
				if (!this._ownsCompactionController(autoCompactionController, "auto")) return false;
				return endBeforeExecution();
			}
			if (!this._ownsCompactionController(autoCompactionController, "auto")) return false;

			const preparation = prepareCompaction(
				this.sessionManager.getBranch(),
				this.settingsManager.getCompactionSettings(),
				reason === "overflow",
			);
			if (!preparation) {
				return endBeforeExecution();
			}
			if (!this._ownsCompactionController(autoCompactionController, "auto")) return false;
			this._emit({ type: "compaction_start", reason, requestId });

			const execution = await this._executeCompaction({
				controller: autoCompactionController,
				owner: "auto",
				reason,
				requestId,
				willRetry,
				agentMessagesAtStart,
			});
			if (!execution.accepted) {
				if (reason === "overflow") this._overflowRecoveryAttempted = false;
				return false;
			}
			if (this._autoCompactionAbortController === autoCompactionController) {
				this._autoCompactionAbortController = undefined;
			}

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
					this._incrementMessageRevision();
				}

				this._scheduleContinuationAfterCurrentEvent();
				return true;
			} else if (this.pendingMessageCount > 0) {
				this._scheduleContinuationAfterCurrentEvent();
				return true;
			} else if (this.agent.hasQueuedMessages()) {
				this._scheduleContinuationAfterCurrentEvent();
				return true;
			}

			return false;
		} catch (error) {
			if (!compactionExecutionOwnsTerminalTransition(error)) {
				return false;
			}
			if (reason === "overflow") this._overflowRecoveryAttempted = false;
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted = isCompactionExecutionAborted(error);
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted,
				willRetry: false,
				requestId,
				errorMessage: aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
			return false;
		} finally {
			if (this._autoCompactionAbortController === autoCompactionController) {
				this._autoCompactionAbortController = undefined;
			}
			finishCompactionWork();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		const finishBindingWork = this._sessionWorkBarrier.begin();
		const bindingPromptReadiness = new Set<Promise<void>>();
		this._extensionBindingPromptReadiness = bindingPromptReadiness;
		try {
			if (bindings.uiContext !== undefined) {
				this._extensionUIContext = bindings.uiContext;
			}
			if (bindings.mode !== undefined) {
				this._extensionMode = bindings.mode;
			}
			if (bindings.commandContextActions !== undefined) {
				this._extensionCommandContextActions = bindings.commandContextActions;
			}
			if (bindings.abortHandler !== undefined) {
				this._extensionAbortHandler = bindings.abortHandler;
			}
			if (bindings.shutdownHandler !== undefined) {
				this._extensionShutdownHandler = bindings.shutdownHandler;
			}
			if (bindings.onError !== undefined) {
				this._extensionErrorListener = bindings.onError;
			}

			this._applyExtensionBindings(this._extensionRunner);
			this.syncPromptCacheSafeWaitEnv();
			await this._extensionRunner.emit(this._sessionStartEvent);
			await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		} finally {
			if (this._extensionBindingPromptReadiness === bindingPromptReadiness) {
				this._extensionBindingPromptReadiness = undefined;
			}
			finishBindingWork();
		}
		await Promise.all(bindingPromptReadiness);
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths, hookPaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0 && hookPaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
			hookPaths: this.buildExtensionResourcePaths(hookPaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		if (skillPaths.length > 0 || promptPaths.length > 0 || themePaths.length > 0) {
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.setToolHookLifecycleObserver((event) => {
			this._emit(event);
		});
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: RUNTIME_EXTENSION_PATH,
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: RUNTIME_EXTENSION_PATH,
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				executeTool: (toolName, params, options) => this.executeTool(toolName, params, options),
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				registerRemovedToolHint: (name, hint) => {
					this.agent.removedToolHints[name] = hint;
				},
				registerLazyToolActivator: (activator) => {
					this._lazyToolActivators.push(activator);
				},
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				setSessionModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setSessionModel(model);
					return true;
				},
				setSessionThinkingLevel: (level) => this.setSessionThinkingLevel(level),
				setSessionFastMode: (enabled) => this.setSessionFastMode(enabled),
			},
			{
				getModel: () => this.model,
				getServiceTier: () => this.serviceTier,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				getAgentDir: () => this._agentDir,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this._extensionEventSignal ?? this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				isCompacting: () => this.isCompacting,
				checkReloadVeto: () => this.checkReloadVeto(),
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				getCompactionSettings: () => this.settingsManager.getCompactionSettings(),
				getPromptCacheSafeWaitSeconds: () => this.resolvePromptCacheSafeWaitSeconds(),
				getLookAtSettings: () => {
					const global = this.settingsManager.getGlobalSettings().lookAt;
					const project = this.settingsManager.getProjectSettings().lookAt;
					return {
						enabled: project?.enabled ?? global?.enabled ?? true,
						models: project?.models ?? global?.models,
					};
				},
				getImageSettings: () => ({
					autoResize: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
				}),
				sessionSettings: {
					getRetryFallbackSettings: () => this.settingsManager.getRetryFallbackSettings(),
					setFallbackChain: async (key, entries) => {
						this.settingsManager.setFallbackChain(key, [...entries]);
						await this.settingsManager.flush();
					},
					removeFallbackChain: async (key) => {
						this.settingsManager.removeFallbackChain(key);
						await this.settingsManager.flush();
					},
					setModelFallbackEnabled: async (enabled) => {
						this.settingsManager.setModelFallbackEnabled(enabled);
						await this.settingsManager.flush();
					},
					setFallbackRevertPolicy: async (policy) => {
						this.settingsManager.setFallbackRevertPolicy(policy);
						await this.settingsManager.flush();
					},
					reload: () => this.settingsManager.reload(),
					getFallbackStatus: () => {
						const active = this._retryFallback.activeState;
						if (!active) return undefined;
						return {
							active: true,
							currentModel: this.model ? `${this.model.provider}/${this.model.id}` : undefined,
							originalSelector: active.originalSelector,
							pinned: active.pinned,
						};
					},
				},
				compact: (options) => {
					const admission = this._claimPendingCompactionAdmission();
					const controller = admission.controller;
					const requestId = randomUUID();
					void (async () => {
						let outcome: "completed" | "failed" | "aborted" = "failed";
						let compactionCompleted = false;
						let disconnected = false;

						try {
							await this._abortActiveAgentAndRetry("system");
							this._disconnectFromAgent();
							disconnected = true;
							this._emit({ type: "compaction_start", reason: "extension", requestId });
							const execution = await this._executeCompaction({
								controller,
								owner: "compaction",
								reason: "extension",
								requestId,
								customInstructions: options?.customInstructions,
								willRetry: false,
							});
							if (execution.accepted) {
								outcome = "completed";
								compactionCompleted = true;
								options?.onComplete?.(execution.result);
							} else {
								outcome = "failed";
								options?.onError?.(new CompactionRejectedError(execution.rejectionCause));
							}
						} catch (error) {
							outcome = isCompactionExecutionAborted(error) ? "aborted" : "failed";
							if (!compactionExecutionOwnsTerminalTransition(error)) {
								return;
							}
							const message = error instanceof Error ? error.message : String(error);
							const aborted = isCompactionExecutionAborted(error);
							this._emit({
								type: "compaction_end",
								reason: "extension",
								result: undefined,
								aborted,
								willRetry: false,
								requestId,
								errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
							});
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						} finally {
							if (
								this._compactionAbortController === controller &&
								this._compactionLifecycle.state.status !== "running"
							) {
								this._compactionAbortController = undefined;
							}
							this._releasePendingCompactionAdmission(admission, outcome);
							if (disconnected && !this.isCompacting) this._reconnectToAgent();
							// A throwing onComplete consumer overwrites outcome in the catch
							// block, so recovery keys off whether compaction itself succeeded.
							if (compactionCompleted) this._resumeQueuedMessagesAfterCompaction();
						}
					})();
				},
				beginCompaction: (options) => this._beginExtensionCompactionFeedback(options.reason),
				updateCompaction: (options) => this._updateExtensionCompactionFeedback(options),
				endCompaction: (options) => this._endExtensionCompactionFeedback(options),
				getMessageRevision: () => this.getMessageRevision(),
				applyCompaction: (precomputed, options) => this.applyCompaction(precomputed, options),
				getSystemPrompt: () => this.systemPrompt,
				getLoadedHookSources: () =>
					this._resourceLoader.getLoadedHookSources?.() ?? {
						agentDir: this._cwd,
						cwd: this._cwd,
						globalHookSourcePaths: [],
						globalHooksPath: `${this._cwd}/hooks.json`,
						preSessionHookSourcePaths: [],
						projectHookSourcePaths: [],
						projectHooksPath: `${this._cwd}/.senpi/hooks.json`,
						runtimeHookSourcePaths: [],
					},
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	/** Fallback-chain configuration warnings calculated when this session started. */
	get fallbackValidationWarnings(): readonly string[] {
		return this._fallbackValidationWarnings;
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<{
		cancelled: boolean;
		reason?: string;
	}> {
		const veto = await this.checkReloadVeto();
		if (veto.cancelled) {
			return veto;
		}
		resetTimings("reload");
		const oldExtensionRunner = this._extensionRunner;
		const oldExtensionIdentities = oldExtensionRunner.getExtensionIdentities();
		const previousFlagValues = oldExtensionRunner.getFlagValues();
		await emitSessionShutdownEvent(oldExtensionRunner, { type: "session_shutdown", reason: "reload" });
		time("shutdown", "reload");
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		time("settings", "reload");
		await this._modelRuntime.reloadConfig();
		// Resolving both scopes from the completed refresh avoids two extra availability
		// scans, but only a snapshot from a SUCCESSFUL refresh may be trusted: refresh()
		// swallows availability errors, so a failed scan must fall back to the runtime and
		// keep the previous refresh-and-surface-the-error behavior.
		const refreshedModels: AvailableModelsSource = this._modelRuntime.hasFreshAvailabilitySnapshot()
			? { getAvailable: async () => this._modelRuntime.getAvailableSnapshot() }
			: this._modelRuntime;
		this.setScopedModels(
			await resolveModelScope(
				getModelNarrowingPatterns({
					legacyEnabledPatterns: this.settingsManager.getEnabledModels(),
				}),
				refreshedModels,
			),
		);
		this.setFavoriteModels(await resolveModelScope(this.settingsManager.getFavoriteModels() ?? [], refreshedModels));
		time("models", "reload");
		await this._resourceLoader.reload({ settingsAlreadyReloadedFor: this.settingsManager });
		time("resources", "reload");
		try {
			this._buildRuntime({
				activeToolNames: this.getActiveToolNames(),
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});
		} finally {
			// An extension removed by this reload must be told even if the rebuild throws
			// (e.g. _refreshToolRegistry rejecting an extension's tool metadata): the new
			// runner is already installed without it, so nothing else would dispose it.
			const newExtensionResolvedPaths = new Set(
				this._extensionRunner.getExtensionIdentities().map((extension) => extension.resolvedPath),
			);
			const removed = oldExtensionIdentities.filter(
				(extension) => !newExtensionResolvedPaths.has(extension.resolvedPath),
			);
			if (removed.length > 0) {
				await oldExtensionRunner.emit({ type: "session_extensions_removed", reason: "reload", removed });
			}
			time("runtime", "reload");
		}

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			this.syncPromptCacheSafeWaitEnv();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
		time("lifecycle", "reload");
		return { cancelled: false };
	}

	/**
	 * Ask extensions whether a full session reload may proceed by emitting the
	 * cancellable `session_before_reload` event. `reload()` always consults this
	 * gate itself, so a cancelling extension prevents the teardown on every
	 * reload path; interactive hosts may additionally pre-check it to warn
	 * without starting their reload UI.
	 */
	async checkReloadVeto(): Promise<{ cancelled: boolean; reason?: string }> {
		if (!this._extensionRunner.hasHandlers("session_before_reload")) {
			return { cancelled: false };
		}
		const result = await this._extensionRunner.emit({ type: "session_before_reload" });
		if (result?.cancel !== true) {
			return { cancelled: false };
		}
		return result.reason === undefined ? { cancelled: true } : { cancelled: true, reason: result.reason };
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Providers mark post-delta failures to prevent replaying visible text/tool calls.
		if (message.errorMessage?.startsWith(TURN_RETRY_SUPPRESSION_PREFIX)) return false;

		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;

		if (isClassifierRefusal(message)) return true;
		if (!message.errorMessage) return false;

		if (message.stopReason === "aborted") {
			return isProviderTimeoutError(message);
		}

		return isRetryableAssistantError(message);
	}

	private _isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		return (
			!message.errorMessage?.startsWith(TURN_RETRY_SUPPRESSION_PREFIX) &&
			message.stopReason === "error" &&
			!isContextOverflow(message, this.model?.contextWindow ?? 0) &&
			!isClassifierRefusal(message) &&
			!message.content.some((content) => content.type === "toolCall") &&
			this._retryFallback.canTryFallback()
		);
	}

	private _getProviderRetryDelayMs(errorMessage: string): number | undefined {
		const markerMs = parseRetryAfterMsMarker(errorMessage);
		if (markerMs !== undefined) return markerMs;
		const hintMs = extract429RetryAfterMs({ bodyText: errorMessage });
		return hintMs;
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: CompactionReason },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns whether retry continuation started, was blocked by compaction, or was not handled
	 */
	private async _handleRetryableError(
		message: AssistantMessage,
		options: { hardErrorFallback?: boolean } = {},
	): Promise<"continued" | "blocked" | "not-handled"> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this._resolveRetry();
			return "not-handled";
		}

		// Retry promise is created synchronously in _handleAgentEvent for agent_end.
		// Keep a defensive fallback here in case a future refactor bypasses that path.
		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		const errorMessage = message.errorMessage || "Unknown error";
		const isRefusal = isClassifierRefusal(message);
		const hardErrorFallback = options.hardErrorFallback === true;
		let switchedFallback = false;
		let is429TierRouted = false;
		let hintTierDelayMs: number | undefined;
		if (hardErrorFallback) {
			// A non-retryable provider failure must never replay on the same model.
			// Billing-class failures never recover on this account, so the fallback
			// switch pins as the session model instead of reverting after the cooldown.
			const reason = isBillingErrorMessage(errorMessage) ? "billing" : "hard-error";
			switchedFallback = await this._retryFallback.tryFallback(reason, { errorMessage });
			if (!switchedFallback) {
				this._resolveRetry();
				return "not-handled";
			}
			// The fallback starts fresh; the failed model's transient attempts do not carry over.
			this._retryAttempt = 1;
		} else if (isRefusal) {
			// Refusals are only retried through a new chain candidate. They never use
			// same-model retries or the transient over-budget fallback escape hatch.
			if (this._retryAttempt + 1 > settings.maxRetries) {
				if (this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: false,
						attempt: this._retryAttempt,
						finalError: message.errorMessage,
					});
				}
				this._retryAttempt = 0;
				this._resetHintTierState();
				this._resolveRetry();
				return "not-handled";
			}
			switchedFallback = await this._retryFallback.tryFallback("refusal", {});
			if (!switchedFallback) {
				const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
				if (exhaustedChainKey) {
					this._emit({ type: "retry_fallback_exhausted", chainKey: exhaustedChainKey, lastError: errorMessage });
				}
				if (this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: false,
						attempt: this._retryAttempt,
						finalError: message.errorMessage,
					});
				}
				this._retryAttempt = 0;
				this._resetHintTierState();
				this._resolveRetry();
				return "not-handled";
			}
			this._retryAttempt++;
		} else {
			if (this._retryAttempt === 0) {
				this._consecutiveProviderStreamStalls = 0;
			}
			// A provider-stream stall means the request was accepted but delivered
			// zero events for the whole idle budget. Replaying the identical payload
			// against a hung provider burns that full budget again per attempt
			// ((1 + maxRetries) * httpIdleTimeoutMs of opaque dead air), so a second
			// consecutive stall escalates to the fallback chain immediately. Fast
			// non-stall failures in between reset the streak and keep the normal
			// same-model recovery semantics.
			const stallError = isProviderStreamStallError(message);
			const escalateAfterRepeatedStall = stallError && this._consecutiveProviderStreamStalls > 0;
			this._consecutiveProviderStreamStalls = stallError ? this._consecutiveProviderStreamStalls + 1 : 0;
			// 429-class detection: retryable AND message carries rate-limit markers.
			const is429Class =
				!stallError &&
				/rate.?limit|(?:^429(?=\s+\{)|(?:\bHTTP\/1\.[01]\s+|\bHTTP\s+|\bstatus(?:\s+code)?\s+|\berror\s+|\bcode\s+)429\b)|too many requests|resource.?exhausted/i.test(
					errorMessage,
				);
			if (is429Class) {
				const hintMs = this._getProviderRetryDelayMs(errorMessage);
				const hintSettings = this.settingsManager.getHintPolicySettings();
				const tier = classifyRateLimitedWait(hintMs, hintSettings);
				is429TierRouted = true;
				if (tier === "no-hint-fast-fallback") {
					// Skip same-model retries entirely; fall back immediately.
					switchedFallback = await this._retryFallback.tryFallback("transient", { errorMessage });
					if (switchedFallback) {
						this._retryAttempt = 1;
					} else {
						const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
						if (exhaustedChainKey) {
							this._emit({
								type: "retry_fallback_exhausted",
								chainKey: exhaustedChainKey,
								lastError: errorMessage,
							});
						}
						this._emit({
							type: "auto_retry_end",
							success: false,
							attempt: 0,
							finalError: message.errorMessage,
						});
						this._retryAttempt = 0;
						this._resetHintTierState();
						this._resolveRetry();
						return "not-handled";
					}
				} else if (tier === "tier1-in-turn") {
					this._retryAttempt++;
					if (this._retryAttempt > settings.maxRetries) {
						// Budget exhausted within tier1; fall back.
						switchedFallback = await this._retryFallback.tryFallback("transient", {
							errorMessage,
							retryAfterMs: this._getProviderRetryDelayMs(errorMessage),
						});
						if (switchedFallback) {
							this._retryAttempt = 1;
						} else {
							const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
							if (exhaustedChainKey) {
								this._emit({
									type: "retry_fallback_exhausted",
									chainKey: exhaustedChainKey,
									lastError: errorMessage,
								});
							}
							this._emit({
								type: "auto_retry_end",
								success: false,
								attempt: this._retryAttempt - 1,
								finalError: message.errorMessage,
							});
							this._retryAttempt = 0;
							this._resetHintTierState();
							this._resolveRetry();
							return "not-handled";
						}
					} else {
						const inTurnResult = nextInTurnDelayMs(
							{
								probePhase: this._probePhase,
								hintDeadlineMs: this._hintDeadlineMs,
								attempt: this._retryAttempt,
								cumulativeHintedWaitMs: this._cumulativeHintedWaitMs,
							},
							hintMs,
							settings.baseDelayMs,
							hintSettings.hintedWaitCapMs,
							Date.now(),
						);
						this._probePhase = inTurnResult.probePhase;
						this._hintDeadlineMs = inTurnResult.hintDeadlineMs;
						this._cumulativeHintedWaitMs = inTurnResult.cumulativeHintedWaitMs;
						if (inTurnResult.demoteToProbeBack) {
							// Cumulative hinted wait exceeded cap; demote to tier2 fallback path.
							const remainingHintMs = Math.max(0, (this._hintDeadlineMs ?? Date.now()) - Date.now());
							switchedFallback = await this._retryFallback.tryFallback("transient", {
								errorMessage,
								retryAfterMs: remainingHintMs,
							});
							if (switchedFallback) {
								this._retryAttempt = 1;
							} else {
								const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
								if (exhaustedChainKey) {
									this._emit({
										type: "retry_fallback_exhausted",
										chainKey: exhaustedChainKey,
										lastError: errorMessage,
									});
								}
								this._emit({
									type: "auto_retry_end",
									success: false,
									attempt: this._retryAttempt - 1,
									finalError: message.errorMessage,
								});
								this._retryAttempt = 0;
								this._resetHintTierState();
								this._resolveRetry();
								return "not-handled";
							}
						} else {
							hintTierDelayMs = inTurnResult.delayMs;
						}
					}
				} else {
					// tier2-fallback-probe-back or tier3-fallback-only: immediate fallback.
					const remainingHintMs = hintMs ?? 0;
					switchedFallback = await this._retryFallback.tryFallback("transient", {
						errorMessage,
						retryAfterMs: remainingHintMs,
					});
					if (switchedFallback) {
						this._retryAttempt = 1;
						if (tier === "tier2-fallback-probe-back") {
							const selector = this._retryFallback.activeState?.originalSelector ?? "";
							this._armProbeBackForDemotedSelector(selector, remainingHintMs);
						}
					} else {
						const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
						if (exhaustedChainKey) {
							this._emit({
								type: "retry_fallback_exhausted",
								chainKey: exhaustedChainKey,
								lastError: errorMessage,
							});
						}
						this._emit({
							type: "auto_retry_end",
							success: false,
							attempt: 0,
							finalError: message.errorMessage,
						});
						this._retryAttempt = 0;
						this._resetHintTierState();
						this._resolveRetry();
						return "not-handled";
					}
				}
			}
			if (!is429TierRouted) {
				this._retryAttempt++;
			}
			if (!is429TierRouted && (this._retryAttempt > settings.maxRetries || escalateAfterRepeatedStall)) {
				switchedFallback = await this._retryFallback.tryFallback("transient", {
					errorMessage,
					retryAfterMs: this._getProviderRetryDelayMs(errorMessage),
				});
				if (switchedFallback) {
					// The new model receives a fresh retry budget; the failed model does not.
					this._retryAttempt = 1;
				} else {
					const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
					if (exhaustedChainKey) {
						this._emit({
							type: "retry_fallback_exhausted",
							chainKey: exhaustedChainKey,
							lastError: errorMessage,
						});
					}
					this._emit({
						type: "auto_retry_end",
						success: false,
						attempt: this._retryAttempt - 1,
						finalError: message.errorMessage,
					});
					this._retryAttempt = 0;
					this._resetHintTierState();
					this._resolveRetry();
					return "not-handled";
				}
			}
		}

		if (switchedFallback) {
			this._consecutiveProviderStreamStalls = 0;
		}

		const providerDelayMs = isRefusal || hardErrorFallback ? undefined : this._getProviderRetryDelayMs(errorMessage);
		const maxRetryDelayMs = this.settingsManager.getProviderRetrySettings().maxRetryDelayMs;
		// For 429-class failures the tier routing replaces the over-budget gate.
		if (!is429TierRouted && providerDelayMs !== undefined && providerDelayMs > maxRetryDelayMs) {
			// A wait this long means the model is unavailable rather than busy, so the
			// configured chain beats failing the turn. The switch is gated: the over-budget
			// branch above may have already switched on this same error, and hopping again
			// here would skip that candidate's own retry budget.
			if (!switchedFallback) {
				switchedFallback = await this._retryFallback.tryFallback("transient", {
					errorMessage,
					retryAfterMs: providerDelayMs,
				});
				if (switchedFallback) {
					this._retryAttempt = 1;
				}
			}
			if (!switchedFallback) {
				this._emit({
					type: "auto_retry_end",
					success: false,
					attempt: this._retryAttempt,
					finalError: `Provider requested retry delay ${providerDelayMs}ms, exceeding configured maximum ${maxRetryDelayMs}ms`,
				});
				this._retryAttempt = 0;
				this._resetHintTierState();
				this._resolveRetry();
				return "not-handled";
			}
		}

		// Transient failures stay on the same model until the retry budget is spent;
		// only the over-budget branch above switches the chain. Both branches that can
		// reach this point with a fallback already applied (hard-error, refusal) set
		// switchedFallback first and force providerDelayMs undefined, so no branch may
		// be reordered to fall through here expecting an implicit switch.
		const nonTierProviderDelayMs = providerDelayMs === 0 ? undefined : providerDelayMs;
		const delayMs = switchedFallback
			? 0
			: is429TierRouted
				? (hintTierDelayMs ?? providerDelayMs ?? settings.baseDelayMs * 2 ** (this._retryAttempt - 1))
				: (nonTierProviderDelayMs ?? settings.baseDelayMs * 2 ** (this._retryAttempt - 1));
		// Prepare before auto_retry_start so an immediate Esc can cancel the retry sleep.
		this._retryAbortController = new AbortController();

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
			this._incrementMessageRevision();
		}

		// Wait with exponential backoff (abortable)
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._resetHintTierState();
			this._retryAbortController = undefined;
			await this._emitAgentSettled();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this._resolveRetry();
			return "not-handled";
		}
		this._retryAbortController = undefined;

		// Turn boundary: a suppression that expired during the backoff sleep lets
		// the retry continue on the restored primary instead of the fallback model.
		await this._maybeRestoreFallbackPrimary();

		// Model fallback (or reversion) can select a smaller context window after
		// the prior retry checks. Revalidate canonical session context immediately
		// before the continuation so a rejected compaction never admits that model.
		const model = this.model;
		const compactionSettings = this.settingsManager.getCompactionSettings();
		const contextTokens = estimateContextTokens(
			filterContextExcludedMessages(this.sessionManager.buildSessionContext().messages),
		).tokens;
		if (
			compactionSettings.enabled &&
			model &&
			shouldCompact(contextTokens, model.contextWindow, compactionSettings)
		) {
			const preRetryCompaction = await this._runPrePromptCompaction(message, true, "threshold", true, true);
			if (!preRetryCompaction && !this._isCompactionOnCooldown()) {
				const attempt = this._retryAttempt;
				this._retryAttempt = 0;
				this._resetHintTierState();
				this._emit({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: new RequiredCompactionError().message,
				});
				this._resolveRetry();
				return "blocked";
			}
			this._skipNextPostRetryCompactionCheck = true;
		}

		// Retry through the barrier-owned scheduled-continuation path after the
		// event handler chain settles. Lifecycle suppression protects queued work
		// while admission settles; known provider-timeout retries additionally skip
		// the first queue poll so user input stays deferred until that request proves
		// responsive. A concurrent low-level Agent prompt is a benign takeover, not
		// a terminal continuation failure.
		const continuation = createProviderTimeoutRetryPlan({
			message,
			streamRetryTimeoutMs: this.settingsManager.getProviderStreamRetryTimeoutMs(),
			timeoutMs: this.agent.timeoutMs,
			streamStartTimeoutMs: this.agent.streamStartTimeoutMs,
		});
		this.agent.suppressQueuedMessageDrain();
		this._scheduleContinuationAfterCurrentEvent(continuation.options, true, continuation.watchdogTimeoutMs);

		return "continued";
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this._resolveRetry();
	}

	/**
	 * Wait for any in-progress retry to complete.
	 * Returns immediately if no retry is in progress.
	 */
	private async waitForRetry(): Promise<void> {
		if (!this._retryPromise) {
			return;
		}

		await this._retryPromise;
		await this.agent.waitForIdle();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
			this._incrementMessageRevision();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
			this._incrementMessageRevision();
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, extraBody, env } = await this._getCompactionRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					extraBody,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state (preserving exact messages still awaiting persistence)
			this._restoreAgentMessagesFromSession();
			this._incrementMessageRevision();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * Cache-safe foreground wait budget for the LIVE current model. Recomputed on
	 * every call so a model switch takes effect immediately.
	 */
	resolvePromptCacheSafeWaitSeconds(): number | undefined {
		const global = this.settingsManager.getGlobalSettings().promptCache;
		const project = this.settingsManager.getProjectSettings().promptCache;
		const merged = global || project ? { ...global, ...project } : undefined;
		return resolvePromptCacheSafeWaitSeconds(this.model, merged, process.env);
	}

	/**
	 * Mirror the budget into the advisory env var read by out-of-process tools.
	 * Last writer wins across in-process sessions; consumers treat it as a hint.
	 */
	syncPromptCacheSafeWaitEnv(): void {
		const budget = this.resolvePromptCacheSafeWaitSeconds();
		if (budget === undefined) delete process.env[PROMPT_CACHE_SAFE_WAIT_ENV];
		else process.env[PROMPT_CACHE_SAFE_WAIT_ENV] = String(budget);
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const messages = filterContextExcludedMessages(this.messages);

		// After compaction, kept assistant usage reflects pre-compaction context size.
		// If no assistant has responded after the boundary yet, fall back to content
		// estimates so auto-compaction can still see current context pressure.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				const tokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
				return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
			}
		}

		const estimate = estimateContextTokens(messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
