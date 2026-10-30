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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	Agent,
	AgentContinuationOptions,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
	InternalAgentChannel,
	PreparedAgentToolCall,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	ProviderRetryWatchdogAbortError,
	prepareAgentToolCall,
	resolveToolNameAlias,
	runToolCall,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessageEvent,
	contentText,
	type JsonObject,
	providerNotConfiguredMessage,
	SERVER_FALLBACK_ABORTED_DIAGNOSTIC,
	supportsAllowedToolChoice,
	supportsConfigurationUpdate,
	type ThinkingSelection,
} from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AuthResult,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
	cleanupSessionResources,
	cursorOverflowCompactionSettings,
	describeProviderFailureForUser,
	isClassifierRefusal,
	isContextOverflow,
	isCursorPayloadResourceExhausted,
	isCursorQuotaResourceExhausted,
	isCursorZeroTokenResourceExhausted,
	isProviderStreamStallError,
	isProviderTimeoutError,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	shouldRetryOverflowWithoutCompact,
	streamSimple,
	stripTurnRetrySuppressionPrefix,
} from "@earendil-works/pi-ai/compat";
import { getCursorContextLimit } from "@earendil-works/pi-ai/utils/cursor-context-limit";
import { isOAuthRefreshUnavailableError } from "@earendil-works/pi-ai/utils/oauth-refresh-error";
import { retryTransientCall } from "@earendil-works/pi-ai/utils/retry";
import { extract429RetryAfterMs, parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import { retryBackoffDelayMs } from "@earendil-works/pi-ai/utils/retry-profile/backoff";
import { type ToolRuntimeKind, ToolRuntimeUnsupportedHostError, toolRuntimeHostRefusal } from "../cli/tool-runtime.ts";
import { getAgentDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import {
	SessionToolChild,
	type SessionToolChildRow,
	toolChildModuleRoots,
} from "../modes/rpc/tool-child/session-child.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { AgentAbortProvenance, type AgentAbortSource } from "./agent-abort-provenance.ts";
import { AgentBusyError } from "./agent-busy-error.ts";
import { AgentRunContinuations } from "./agent-run-continuation.ts";
import { AgentSettledDelivery, type DeferredAgentSettledAction, DeferredTurnClaim } from "./agent-settled-delivery.ts";
import { resolveAssistantUsageScope } from "./assistant-usage-scope.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { formatCompactionFailure } from "./compaction-failure-text.ts";
import type { CredentialReplacement } from "./auth-storage.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { envValue } from "./brand.ts";
import { compactUpdatesEnabled } from "./engine-socket-flag.ts";
import { QueuedInputDispositions } from "./queued-input-dispositions.ts";
import { carryRecovery, recoveryCarrier, SessionRecoveryIdentity } from "./session-recovery-identity.ts";
import type { BrowserEngine } from "./browser-engine.ts";
import {
	type ClientMessageIdentity,
	clientMessageIdentity,
	type PreparedClientInput,
	readClientMessageIdentity,
} from "./client-message-identity.ts";
import {
	type CacheFriendlySummaryOptions,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	resolveThresholdContextTokens,
	shouldCompact,
} from "./compaction/index.ts";
import { CompactionLifecycleCoordinator, type CompactionLifecycleState } from "./compaction/lifecycle.ts";
import { isTurnStuckOnContextOverflow } from "./compaction/stuck-overflow.ts";
import { isWarmSummaryAnchorValid } from "./compaction/warm-anchor.ts";
import type { CompactionModelSelector } from "./compaction-settings-access.ts";
import {
	CONTINUE_FROM_LEAF_CUSTOM_TYPE,
	CONTINUE_FROM_LEAF_DIRECTIVE,
	ContinueFromLeafError,
	trackTurnAdmission,
} from "./continue-from-leaf.ts";
import { admitCursorHistory, cursorAdmissionBudgetBytes } from "./cursor-history-admission.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { resolveDiscoveredResourcePaths } from "./discovered-resource-scope.ts";
import type { DynamicSystemPromptPart } from "./dynamic-prompt/build.ts";
import {
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	type PromptSurface,
	resolvePromptSurface,
} from "./dynamic-prompt/index.ts";
import {
	AssistantEditError,
	assertExpectedLeaf,
	assistantTextEquals,
	buildEditedAssistantMessage,
	SessionStreamingError,
} from "./edited-assistant-message.ts";
import {
	assertExpectedUserLeaf,
	buildEditedUserMessage,
	UserEditError,
	userTextEquals,
} from "./edited-user-message.ts";
import { ENGINE_PAUSED_ENTRY_TYPE, enginePauseSinceLastTurn, settledRepetitiveTurnPause } from "./engine-paused.ts";
import { EngineTurnHold, engineTurnHoldHistory, engineWakeSource, type SessionHoldEvent } from "./engine-turn-hold.ts";
import { EngineTurnInput } from "./engine-turn-input.ts";
import {
	ENGINE_TURN_LIMIT_ENTRY_TYPE,
	ENGINE_TURN_LIMIT_EVENT,
	ENGINE_TURN_START_ENTRY_TYPE,
	type EngineTurnStartRecord,
	engineTurnHistory,
	engineTurnLimitNotice,
	engineTurnStop,
	isUserDirectedTurn,
	resetsEngineTurnHistory,
} from "./engine-turn-limit.ts";
import { EngineTurnRelease } from "./engine-turn-release.ts";
import {
	type EnvironmentContext,
	environmentContextMessageIfChanged,
	resolveEnvironmentContext,
} from "./environment-context.ts";
import { areExperimentalFeaturesEnabled } from "./experimental.ts";
import {
	type ExportOptions,
	exportSessionToHtml,
	renderSessionToHtml,
	type ToolHtmlRenderer,
} from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import { reportExtensionHandlerStall } from "./extension-handler-stall-report.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./extensions/builtin/anthropic-subscription/account-management.ts";
import { isSignInAgainError } from "./extensions/builtin/anthropic-subscription/sign-in-again.ts";
import { askUserAnswerDisplayText } from "./extensions/builtin/ask-user/format.ts";
import { getPromptCachePrewarmUsage } from "./extensions/builtin/cache-keepalive/prewarm-entry.ts";
import {
	type ModelUsabilityAdmission,
	ModelUsabilityBudgetError,
	type ModelUsabilityBudgetProjection,
	projectModelUsabilityBudget,
} from "./extensions/builtin/compaction/model-usability-budget.ts";
import { resolveEffectiveReserveTokens, shouldTriggerCompaction } from "./extensions/builtin/compaction/policy.ts";
import {
	isAutomaticCompactionBlocked,
	wouldCompactionOverflow,
} from "./extensions/builtin/compaction/rejected-recovery.ts";
import {
	createResumeCompactionRequirement,
	type ResumeCompactionRequirement,
} from "./extensions/builtin/compaction/resume-admission.ts";
import {
	planResumeSlice,
	RESUME_SLICE_ORIGIN,
	RESUME_SLICE_SCHEMA,
	type ResumeSlicePlan,
	resumeSliceNotice,
} from "./extensions/builtin/compaction/resume-slice.ts";
import {
	createPendingModelSwitch,
	type PendingModelSwitch,
	pendingSwitchKeepRecentTokens,
} from "./extensions/builtin/compaction/switch-admission.ts";
import { WAKE_SOURCE_STATE_EVENT } from "./extensions/builtin/monitor-state-event.ts";
import { CODEX_RESPONSES_API, type ServiceTier } from "./extensions/builtin/service-tier.ts";
import { deriveExtensionRegistrationId } from "./extensions/builtin/tool-search/engine/marker.ts";
import { adoptToolSearchServiceForSession, type ToolSearchService } from "./extensions/builtin/tool-search/service.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	ExecuteToolError,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionToolHookLifecycleEvent,
	type ExtensionUIContext,
	type InputAttribution,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type SystemPromptChangeEvent,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { projectKernelPrelude } from "./extensions/kernel-prelude.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type {
	ApplyCompactionOptions,
	ApplyCompactionResult,
	CompactionReason,
	CompactionRejectionCause,
	FilesystemPolicyChecker,
	ModelSelectSource,
	SendMessageItem,
	SendMessageOptions,
	SendMessageReceipt,
	SessionHoldRecord,
	ToolChildJob,
} from "./extensions/types.ts";
import { normalizeToolExposure, RUNTIME_EXTENSION_PATH } from "./extensions/types.ts";
import { createUserActivitySource, emitUserActivity, type UserActivityKind } from "./extensions/user-activity.ts";
import { deliveryIdOf, ExternalAdmission, type InputHold } from "./external-admission.ts";
import { HELD_INPUT_ENTRY, type HeldInput, HeldInputs, type HoldInputResult, heldInputHistory } from "./held-inputs.ts";
import { shouldWarnHighReasoning } from "./high-reasoning-warning.ts";
import { customTurnOrigin, type InputOrigin, inputAttributionOf, inputOriginOf } from "./input-origin.ts";
import { markInterrupted, type StopInterrupt } from "./interrupted-tool-result.ts";
import {
	deliveredReceipts,
	type ItemizedAdmission,
	itemNoticeMessage,
	type PersistWatcher,
	QueuedDeliveryCleared,
} from "./itemized-send.ts";
import { LazyToolActivation } from "./lazy-tool-activation.ts";
import { heldLifecycleNotice, messageTicket } from "./lifecycle-delivery.ts";
import { lifecycleEditLeaf } from "./lifecycle-edit-leaf.ts";
import { LifecycleSessionBinding } from "./lifecycle-session-binding.ts";
import {
	isManualContinueSubmission,
	MANUAL_CONTINUE_CUSTOM_TYPE,
	MANUAL_CONTINUE_DIRECTIVE,
} from "./manual-continue.ts";
import { clearMcpGrantPresentations } from "./mcp-grant-presentations.ts";
import { registerMemoryReportSession } from "./memory-report/memory-report-registry.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	convertToLlm,
	filterContextExcludedMessages,
} from "./messages.ts";
import {
	heldSwitchOrigin,
	type ModelChangeOrigin,
	modelChangeLogFields,
	SDK_MODEL_CHANGE,
} from "./model-change-origin.ts";
import { ModelNotReadyError } from "./model-not-ready-error.ts";
import { ModelRegistry } from "./model-registry.ts";
import { type AvailableModelsSource, getModelNarrowingPatterns, resolveModelScope } from "./model-resolver.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { ModelSwitchAuthError } from "./model-switch-auth-error.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { type PendingInputSnapshot, type PendingInputUpdate, SessionPendingInputs } from "./pending-input-session.ts";
import { PROMPT_CACHE_SAFE_WAIT_ENV, resolvePromptCacheSafeWaitSeconds } from "./prompt-cache-budget.ts";
import { PromptCachePrefixBuilds } from "./prompt-cache-prefix-request.ts";
import type { PromptSizeInventory } from "./prompt-size-startup.ts";
import { expandPromptTemplateWithMetadata, type PromptTemplate } from "./prompt-templates.ts";
import {
	isRequestLevelRefusal,
	type ProviderFailure,
	providerFailureOf,
	type SelectedModel,
	selectedModelOf,
} from "./provider-failure.ts";
import { rejectedImageSources } from "./provider-rejected-images.ts";
import { createProviderTimeoutRetryPlan, runBoundedRetryContinuation } from "./provider-timeout-retry.ts";
import { QueuedInputAges } from "./queued-input-age.ts";
import { checkSessionReloadVeto } from "./reload-veto.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { isBillingErrorMessage } from "./retry-fallback/billing.ts";
import { formatSelector } from "./retry-fallback/chains.ts";
import {
	acquireFallbackCircuits,
	createFallbackCircuitAccess,
	type FallbackCircuitAccess,
	monotonicNow,
} from "./retry-fallback/circuit.ts";
import { isHealthExhaustionFailure } from "./retry-fallback/circuit-probes.ts";
import { RetryFallbackController } from "./retry-fallback/controller.ts";
import { SelectorCooldowns } from "./retry-fallback/cooldown.ts";
import {
	classifyRateLimitedWait,
	degradeWithoutFallback,
	type HintTier,
	nextInTurnDelayMs,
	type ProbePhase,
	probeBackSchedule,
} from "./retry-fallback/hint-policy.ts";
import { createFallbackLogger } from "./retry-fallback/log.ts";
import {
	createModelConfigErrorReporter,
	isModelConfigFailure,
	type ModelConfigErrorEvent,
	type ModelConfigErrorReporter,
} from "./retry-fallback/model-config-error.ts";
import { ProbeBackScheduler } from "./retry-fallback/probe-scheduler.ts";
import {
	REQUEST_SHAPE_FAILURE_TEXT,
	REQUEST_SHAPE_RECOVERY_ENTRY_TYPE,
	REQUEST_SHAPE_RECOVERY_NOTE,
	RequestShapeRecovery,
} from "./retry-fallback/request-shape.ts";
import {
	AccountUsageLimitError,
	describeUsageLimitEntry,
	describeUsageLimitMessage,
	usageLimitScope,
} from "./retry-fallback/usage-limit.ts";
import { validateFallbackChains } from "./retry-fallback/validate.ts";
import { type InheritResult, type ReleaseInheritedResult, RunHolds, type RunRef } from "./run-holds.ts";
import { startRunResumeTurn } from "./run-resume-turn.ts";
import { SecurityNoticeSnapshot } from "./security-notices.ts";
import { isSessionBusySnapshot, type SessionActivitySnapshot, WakeSourceTracker } from "./session-activity.ts";
import {
	type ControlEndpointHost,
	createSessionControlActions,
	type GenerationSessionControlActions,
} from "./session-control-actions.ts";
import { computeSessionFailureReport, type SessionFailureReport } from "./session-failure-report.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { ChildLifecycleReport, LifecycleApi, SessionLifecycleEvent } from "./session-lifecycle-types.ts";
import { createSessionLogger, type SessionLogger } from "./session-log.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionProjection } from "./session-manager.ts";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	getSessionContextEntryId,
	type SessionHeader,
	SessionManager,
	type SessionRecoveryCause,
} from "./session-manager.ts";
import { SessionThinkingMemory, type ThinkingLevelSource } from "./session-thinking-memory.ts";
import { restoreMovedState } from "./session-move/extension-state.ts";
import type { SessionRelocationHost } from "./session-relocation.ts";
import { generateSessionTitle, sessionTitleRetryPolicy, shouldSkipSessionTitle } from "./session-title-generator.ts";
import { SessionWorkBarrier } from "./session-work-barrier.ts";
import {
	DEFAULT_STREAM_START_TIMEOUT_MS,
	DEFAULT_TOOL_NAMES,
	type SettingsManager,
	type SettingsSourceSelection,
} from "./settings-manager.ts";
import { BlockedSkillLinkError, readSkillFileChecked } from "./skill-access.ts";
import {
	formatSkillInvocationPrompt,
	parseSkillInvocationTokens,
	removeSkillInvocationTokens,
	type SkillInvocationPromptSkill,
	type SkillInvocationSyntax,
	type SkillInvocationToken,
} from "./skill-invocation.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.ts";
import type { Skill } from "./skills.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { stopResumeDirective } from "./stop-resume-directive.ts";
import { type AgentSessionStructuredRecord, StructuredSessionLane } from "./structured-session-lane.ts";
import {
	type ClampedThinkingSelection,
	clampThinkingSelection,
	getSupportedThinkingLevels,
	getThinkingClampNotice,
	supportsMax,
	supportsXhigh,
	type ThinkingClampNotice,
} from "./thinking-levels.ts";
import { resetTimings, time } from "./timings.ts";
import { ToolBarrier, type ToolBarrierSpec, toolBarrierSpecError } from "./tool-barrier.ts";
import { type SessionMessageUpdateEvent, withResolvedToolName } from "./tool-call-display-name.ts";
import {
	createSessionHostCallHandler,
	type HostCallTarget,
	type RegisteredHostCallKind,
} from "./tool-child-host-calls.ts";
import type { StuckModuleNotice } from "./tool-dispatch/in-process-module.ts";
import { childModuleRoots, offload } from "./tool-dispatch/offload.ts";
import { createToolDispatcher, type ToolDispatcher } from "./tool-dispatch/tool-dispatcher.ts";
import type { BashOperations } from "./tools/bash.ts";
import { composeFilesystemPolicies } from "./tools/filesystem-policy.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { TranscriptWriteFailures } from "./transcript-write-failures.ts";
import {
	AgentDeadlineTracker,
	resolveTurnDeadlineSettings,
	TURN_DEADLINE_ENTRY_TYPE,
	TURN_DEADLINE_GRACE_MS,
	type TurnDeadline,
	type TurnDeadlineWarning,
} from "./turn-deadline.ts";
import { commandShapedName, findUnknownCommand } from "./unknown-command.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import { joinUserTextBlocks, keepsTextBlocksVerbatim, userMessageText, userTextContent } from "./user-text-blocks.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";
import { CustodyViolation, DeliveryTicketRefused, ENGINE_DELIVERY_KEY_PREFIX } from "./work-obligations.ts";

/** Externally registered tools routed through eval in addition to declared eval exposure. */
const EVAL_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["workflow", "monitor"]);

/** Sample eval-cell call for an eval-only tool, using the argument name that tool actually takes. */
function evalHelperCall(name: string): string {
	if (name === "bash" || name === "powershell") return `tool.${name}({ command: "..." })`;
	if (name === "grep" || name === "glob") return `tool.${name}({ pattern: "...", path: "..." })`;
	if (name === "workflow") return `tool.${name}({ action: "..." })`;
	if (name === "monitor") return `tool.monitor({ description: "...", command: "...", filter: "..." })`;
	return `tool.${name}({ ... })`;
}
const TURN_RETRY_SUPPRESSION_PREFIX = "senpi:no-turn-retry:";
/**
 * Compact-and-retry rungs one overflow may climb before the turn gives up: the first
 * keeps the configured recent tail, the second keeps only the summary and the turn
 * being answered. A new turn
 * admission starts over, so a user prompt or goal continuation is never refused by a
 * rung spent in an earlier turn (oh-my-openagent#8411, senpi#2480).
 */
const OVERFLOW_RECOVERY_RUNGS = 2;
const OVERFLOW_RECOVERY_EXHAUSTED_MESSAGE =
	"Context overflow recovery failed after two compact-and-retry attempts. Try reducing context or switching to a larger-context model.";
const DEFERRED_RETRY_QUEUE_OWNERS = new WeakSet<object>();

// ============================================================================
// Skill Invocation Formatting and Parsing (see ./skill-invocation.ts)
// ============================================================================

/** The turn_end boundary report for a turn still unwinding after dispose() (senpi#2995). */
export const TURN_END_SKIPPED_AFTER_SHUTDOWN =
	"turn_end skipped: the session shut down during this turn, so its last response was not saved";

export {
	formatSkillInvocationPrompt,
	MAX_SKILL_EXPANSIONS_PER_PROMPT,
	MAX_SKILL_INVOCATION_TOKENS_PER_PROMPT,
	type ParsedSkillBlock,
	parseSkillBlock,
	parseSkillInvocationTokens,
	type SkillInvocationPromptSkill,
	type SkillInvocationSyntax,
	type SkillInvocationToken,
} from "./skill-invocation.ts";

export interface CommandInvocation {
	name: string;
	source: "extension" | "prompt";
	sourceInfo: SourceInfo;
	syntax: "slash";
}

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Why a session-level abort happened, when the caller knows: today only a session replacement says so. */
export interface AgentAbortCause {
	readonly kind: "session_replaced";
	/** What replaced the session: `new_session`, `fork` or a `switch_session`/resume. */
	readonly reason: "new" | "fork" | "resume";
	/** The replacement's transcript and durable session id, when they are known before the teardown. */
	readonly targetSessionFile?: string;
	readonly targetSessionId?: string;
}

type AgentSessionAgentEndEvent = Extract<AgentEvent, { type: "agent_end" }> & {
	willRetry: boolean;
	aborted?: true;
	abortSource?: AgentAbortSource;
	/** Set when the turn's inactivity lease or hard max runtime ended it (see turn-deadline.ts). */
	deadline?: TurnDeadline;
	/** Present when the turn ended with a provider error; see provider-failure.ts. */
	failure?: ProviderFailure;
	/** Present when the run was aborted by an abort that named its cause (for example a session replacement). */
	abortCause?: AgentAbortCause;
};

function withProviderFailure(
	event: AgentSessionAgentEndEvent,
	selected: SelectedModel | undefined,
): AgentSessionAgentEndEvent {
	const failure = providerFailureOf(event.messages, selected);
	return failure === undefined ? event : { ...event, failure };
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_start" | "agent_end" | "message_update" }>>
	/** The lifecycle run identity, bound before asynchronous event delivery; older engines omit it. */
	| { type: "agent_start"; runId?: string }
	| AgentSessionAgentEndEvent
	| SessionMessageUpdateEvent
	| { type: "agent_settled" }
	| { type: "agent_idle" }
	/** The session's tool child changed state (senpi#3566; the minimal record todo 14 extends). */
	| { type: "session_tool_child"; state: "spawned" | "exited" | "respawned"; generation: number; pid: number }
	| { type: "session_abort" }
	/** A workspace-writing tool call started waiting on the turn's tool barrier (senpi#3717). */
	| { type: "tool_barrier_waiting"; id: string; toolCallId: string; toolName: string }
	/** The tool barrier's ceiling passed before a release; it opened by itself (senpi#3717). */
	| { type: "tool_barrier_expired"; id: string; deadlineMs: number }
	| SessionHoldEvent
	| SessionLifecycleEvent
	| {
			type: "resume_compaction_required";
			projection: ModelUsabilityBudgetProjection;
			notice: string;
	  }
	| {
			type: "resume_context_reduced";
			tokensBefore: number;
			tokensAfter: number;
			droppedEntries: number;
			notice: string;
	  }
	/**
	 * The session file's tail was torn by an interrupted write (a full disk) and was set aside in `backupPath`; every
	 * complete record is kept (senpi#4295). Emitted live once, and replayed to each surface that attaches before the
	 * next prompt, so the person is told once wherever they look.
	 */
	| {
			type: "session_recovered";
			cause: SessionRecoveryCause;
			backupPath: string;
			droppedBytes: number;
			notice: string;
	  }
	| { type: "continuation_error"; errorMessage: string }
	/**
	 * A background turn (an extension's `sendMessage` with `triggerTurn`, or `sendUserMessage`) could not start
	 * because no provider is ready. Emitted once until a turn is admitted again, with the same guidance a typed
	 * prompt gets, instead of an extension error.
	 */
	| { type: "provider_required"; notice: string }
	/** The session file refused a message of the running turn; the message is not in the transcript. */
	| { type: "transcript_write_failed"; role: AgentMessage["role"]; errorMessage: string }
	/**
	 * An in-process `ctx.offload` module ran past its deadline and grace and cannot be stopped: it keeps its file locks,
	 * every write waiting on them fails fast, and they are released when it finishes or the session is closed.
	 */
	| ({ type: "offload_module_stuck" } & StuckModuleNotice)
	| {
			type: "skill_invocation";
			skills: readonly {
				name: string;
				path: string;
				syntax: SkillInvocationSyntax;
			}[];
	  }
	| {
			type: "command_invocation";
			command: CommandInvocation;
	  }
	/** A pending input changed in durable custody (senpi#3549); `changes` are complete projections. */
	| ({ type: "pending_input_update" } & PendingInputUpdate)
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
			ordered: readonly QueuedInput[];
	  }
	| { type: "compaction_start"; reason: CompactionReason; requestId?: string }
	| {
			type: "compaction_progress";
			reason: CompactionReason;
			delta?: string;
			text?: string;
	  }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| ExtensionToolHookLifecycleEvent
	| SystemPromptChangeEvent
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "high_reasoning_warning";
			modelId: string;
			provider: string;
			thinkingLevel: ThinkingLevel;
	  }
	/** An explicit thinking request ran at a lower level than asked (senpi#2395); emitted once per model and level. */
	| ({ type: "thinking_level_clamped" } & ThinkingClampNotice)
	| ({ type: "settings_source_selected" } & SettingsSourceSelection)
	/** Active model changed; `thinkingLevel` is the level in force AFTER the switch. */
	| {
			type: "model_changed";
			model: Model<any>;
			thinkingLevel: ThinkingLevel;
			source: ModelSelectSource;
			/** What made the switch and who issued it (senpi#2870). */
			origin: ModelChangeOrigin;
			/** The model active before the switch, when there was one. */
			previousModel?: Model<any>;
			/** The switch landed while a turn was streaming. */
			duringTurn: boolean;
	  }
	/** A switch the session refused; recorded so the attempt survives (#1526). */
	| {
			type: "model_change_rejected";
			model: Model<any>;
			reason: "context-budget" | "auth";
			detail: string;
			contextWindow?: number;
			liveContextTokens?: number;
			requiredTokens?: number;
			shortfallTokens?: number;
			safetyMarginProfile?: string;
	  }
	| {
			type: "model_change_skipped";
			model: Model<any>;
			contextWindow: number;
			liveContextTokens: number;
			requiredTokens: number;
			shortfallTokens: number;
			safetyMarginProfile: string;
			direction: "forward" | "backward";
	  }
	| {
			type: "model_change_cancelled";
			origin: ModelChangeOrigin;
			reason: "superseded" | "context-budget" | "error";
			detail?: string;
	  }
	/** A switch accepted but held until the next send can compact for it (#1873). */
	| {
			type: "model_change_pending";
			model: Model<any>;
			contextWindow: number;
			liveContextTokens: number;
			requiredTokens: number;
			shortfallTokens: number;
			notice: string;
	  }
	/** Effective service tier or fast-mode state changed. */
	| { type: "service_tier_changed"; tier?: ServiceTier; fastMode: boolean }
	| {
			type: "session_settings_changed";
			steeringMode: "all" | "one-at-a-time";
			followUpMode: "all" | "one-at-a-time";
			autoCompactionEnabled: boolean;
	  }
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
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| {
			type: "retry_fallback_applied";
			from: string;
			to: string;
			chainKey: string;
			reason: "transient" | "refusal" | "hard-error" | "billing";
			/** Set when a usage limit caused the switch: `model` binds one model, `account` the whole provider. */
			limit?: "model" | "account";
	  }
	| { type: "retry_fallback_succeeded"; model: string; chainKey: string }
	| {
			type: "retry_fallback_reverted";
			from: string;
			to: string;
			/** `fallback-unusable`: the fallback could not serve (billing or an account limit), so the session returned early. */
			cause?: "fallback-unusable";
	  }
	| { type: "retry_fallback_exhausted"; chainKey: string; lastError: string }
	| ModelConfigErrorEvent
	| {
			type: "server_fallback_aborted";
			from: string;
			to: string;
			chainConfigured: boolean;
	  }
	// Auth login flow (task 13) is additive with event-only completion. The
	// login_start command responds immediately, then the OAuth URL and the
	// terminal result arrive here, because an interactive browser round-trip
	// cannot fit inside the request timeout.
	| { type: "auth_login_url"; provider: string; url: string }
	/**
	 * A login progress line, such as a `provider_login_start` handler's download status (senpi#4436). The line is
	 * `text`, not `message`: event consumers detect chat-message events with `"message" in event`.
	 */
	| { type: "auth_login_progress"; provider: string; text: string }
	| {
			type: "auth_login_end";
			provider: string;
			success: boolean;
			error?: string;
			/** A successful login that replaced a credential of the other kind names it (senpi#3486). */
			replaced?: CredentialReplacement["replaced"];
			/** Where the replaced credential was backed up, when it was. */
			backupPath?: string;
			/** The account a Claude CLI sign-in signed in (senpi#4436). */
			account?: { name: string };
			/** That account's sign-in connection test. */
			check?: { model: string; outcome: "ok" | "failed"; reason?: string; at: number };
	  }
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
	| {
			type: "retry_probe_scheduled";
			selector: string;
			atMs: number;
			probeIndex: 1 | 2;
	  }
	| {
			type: "retry_probe_result";
			selector: string;
			ok: boolean;
			errorMessage?: string;
	  }
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
	/** @internal Construction channel for senpi's session layer only; absent for externally supplied Agents. */
	internalChannel?: InternalAgentChannel;
	/** Explicit service tier for the initial model. */
	serviceTier?: ServiceTier;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Directory containing runtime logs and global agent configuration. */
	agentDir?: string;
	/** Clock override for fallback selector cooldowns (tests only). */
	fallbackNow?: () => number;
	/** Wall clock used to translate provider reset timestamps into cooldown durations. */
	fallbackWallNow?: () => number;
	/** Random source for retry jitter (tests only). */
	retryRandom?: () => number;
	/**
	 * Send cwd and date as an append-only environment-context message before a turn (senpi#2093).
	 * Default true; test fixtures that pin exact transcripts pass false.
	 */
	environmentContext?: boolean;
	/** Global model narrowing for selectors and startup model choice (from --models / enabledModels) */
	scopedModels?: Array<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
		thinkingSelection?: ThinkingSelection;
		serviceTier?: ServiceTier;
	}>;
	/** Favorite models to cycle through with Ctrl+P */
	favoriteModels?: Array<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
		thinkingSelection?: ThinkingSelection;
		serviceTier?: ServiceTier;
	}>;
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
	/** Configured built-in defaults; fork-native builtin extension tools outside this set are omitted. */
	defaultToolNames?: string[];
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, reload activates
	 * tools newly added to the setting. Tools removed from it stay active.
	 */
	usesDefaultTools?: boolean;
	/** Tool names that remain executable only through the registered eval tool. */
	evalOnlyToolNames?: string[];
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
	/** Where this session's replies render; omitted means `SENPI_PROMPT_SURFACE` decides. */
	promptSurface?: PromptSurface;
	/** Browser engine this session's skills drive; omitted means none was chosen. */
	browserEngine?: BrowserEngine;
	/** Caller env for this session's tool subprocesses (`open_session.env`, senpi#4381); omitted means none. */
	sessionEnv?: Readonly<Record<string, string>>;
	/** Tool runtime for this session (senpi#3566); absent means `in-process`. */
	toolRuntime?: ToolRuntimeKind;
	/** Where the startup thinking level came from (senpi#3819); absent means `default`. */
	initialThinkingLevelSource?: ThinkingLevelSource;
}

type SessionModelEntry = {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	thinkingSelection?: ThinkingSelection;
	serviceTier?: ServiceTier;
};

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
	/** Aim the reduction at another model's window while this model summarizes (#1873). */
	keepRecentTokensOverride?: number;
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
	const diagnostic = details as {
		event?: unknown;
		compactionRequestId?: unknown;
	};
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
		case "external-owner":
			return "Compaction rejected: the active provider owns compaction for this session.";
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

/** The error a turn ends with when a required compaction could not bring the context back under the window. */
export const REQUIRED_COMPACTION_ERROR_MESSAGE =
	"Context remains above the compaction threshold because compaction did not complete";

class RequiredCompactionError extends Error {
	constructor() {
		super(REQUIRED_COMPACTION_ERROR_MESSAGE);
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
	readonly sizesOnly?: boolean;
	/** Filesystem lookups for a sizes-only report; honoured only with `sizesOnly`. */
	readonly promptSizeInventory?: PromptSizeInventory;
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface TreeNavigationOptions {
	/** navigateTree only: resume the exact entry; select (default) puts user/custom text in the editor. */
	intent?: "select" | "resume";
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
	/** Leaf the caller last observed; the mutation is refused with `stale-leaf` when the session moved on. */
	expectedLeafId?: string;
}

export interface AssistantEditResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
	/** The replacement text matched the original, so nothing was appended. */
	unchanged?: boolean;
	/** Id of the appended edited assistant entry. */
	entryId?: string;
}

/** Result of {@link AgentSession.editUserMessage}; the edited-assistant shape, field for field. */
export type UserEditResult = AssistantEditResult;

/** How a steer() or followUp() input was dispatched. */
export type QueuedInputDisposition = "handled" | "queued";

/** Options for AgentSession.prompt() */
export type PromptDisposition = QueuedInputDisposition | "started";

export type QueuedInput = ClientMessageIdentity & {
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly enqueueOrder: number;
	/** Session-unique id of this queued input (`q_<n>`), stable until it is delivered or removed. */
	readonly queuedId: string;
	/** 1 when queued, +1 on every edit: a change can name the revision it was based on (senpi#3459). */
	readonly revision: number;
};

/**
 * What a dequeue or edit of one queued input did; `already_delivered` once the input reached a turn, `conflict`
 * when the caller's `expectedRevision` is not the input's current revision (nothing was changed).
 */
export type QueuedInputChange = "removed" | "edited" | "already_delivered" | "not_found" | "conflict";

/** A queued-input change applies only while the input is still at this revision. */
export interface QueuedInputChangeOptions {
	readonly expectedRevision?: number;
}

export type ClearedQueue = {
	steering: string[];
	followUp: string[];
	/** Global enqueue order, independent of native delivery priority. */
	readonly ordered: readonly QueuedInput[];
};

export const RESUME_EFFECT_ENTRY = "session-resume-effect";

/** Recorded `resume_session` outcomes by effect id, read without keeping a full-history view (senpi#2537). */
const resumeEffectHistory: HistoryReducer<Map<string, ResumeSessionAnswer>> = {
	initial: () => new Map(),
	add: (effects, entry) => {
		if (entry.type !== "custom" || entry.customType !== RESUME_EFFECT_ENTRY) return effects;
		const data = entry.data as { effectId?: unknown; answer?: ResumeSessionAnswer } | undefined;
		if (typeof data?.effectId === "string" && data.answer !== undefined) effects.set(data.effectId, data.answer);
		return effects;
	},
};

export interface ResumeSessionRequest {
	readonly expectedSeq?: number;
	readonly mode?: "continue" | "release";
	readonly message?: string;
	readonly effectId?: string;
}

export interface ResumeSessionAnswer {
	readonly resumed: boolean;
	readonly reason?: "stale" | "not_paused" | "resume_through_parent";
	readonly parentSessionId?: string;
	readonly pauseSeq: number;
	readonly turnStarted: boolean;
	readonly deliveredNotices: number;
	readonly deliveredHeldInputs: number;
	readonly replayed?: boolean;
}

/**
 * The origin an input is tagged and released with: an explicit origin (a person's answer, classified when it is
 * delivered through the extension API) wins over the one its source implies.
 */
function originOf(
	options: { readonly source?: InputSource; readonly inputOrigin?: InputOrigin } | undefined,
): InputOrigin {
	return options?.inputOrigin ?? inputOriginOf(options?.source);
}

/** The attribution an input's `input` event reports (`inputAttributionOf`); RPC input needs the connection's role. */
function attributionOf(
	options:
		| { readonly source?: InputSource; readonly inputOrigin?: InputOrigin; readonly interactiveUser?: boolean }
		| undefined,
): InputAttribution {
	return inputAttributionOf({
		origin: originOf(options),
		source: options?.source,
		interactiveUser: options?.interactiveUser,
	});
}

/** A human input about to be queued or admitted (senpi#3811 design 4.4). */
export interface HumanInputAdmittedEvent {
	readonly kind: "prompt" | "steer" | "follow_up" | "answer" | "resume";
	readonly at: number;
}

/** Options accepted by the queued-input entry points `steer()` and `followUp()`. */
export interface QueuedInputOptions extends ClientMessageIdentity {
	/**
	 * Recovery-ordered enqueue position. A reconnecting client replays its pending
	 * messages with their original order so the queue is rebuilt as the user typed it.
	 */
	enqueueOrder?: number;
	/** Input provenance reported to `input` extension handlers; defaults to "interactive". */
	source?: InputSource;
	/** Who the input came from; defaults from `source` (see `originOf`). */
	inputOrigin?: InputOrigin;
	/** RPC input: the connection declared `interactive_user`; without it the `input` event attributes it to an agent. */
	interactiveUser?: boolean;
	/** Persist the prepared queue record before publishing or enqueuing it. */
	onQueuedInput?: (input: PreparedClientInput) => void;
}

/** Internal: the id of the `input` event a queued input passed, so its delivery can report `started`. */
type QueuedInputEventId = { readonly inputId?: string | undefined };

export interface PromptOptions extends ClientMessageIdentity {
	/** Internal: this input was already reported to `onHumanInputAdmitted` by the caller, so it is not reported again. */
	humanInputReported?: boolean;
	/** Internal: the pause seq when `prompt()` accepted this input; a Stop after it holds the input (senpi#3811). */
	observedPauseSeq?: number;
	/** Internal: called when a newer Stop turned this input into held input instead of a turn. */
	onHeldByNewerStop?: () => void;
	/** Where the input sorts among queued inputs if it ends up queued (a replaying client keeps its order). */
	enqueueOrder?: number;
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** Internal: the text blocks an extension sent `text` as; kept as separate blocks while they still spell it. */
	textBlocks?: readonly string[];
	/** Internal: who started this input when it differs from `source` (a person's answer sent through the extension API). */
	inputOrigin?: InputOrigin;
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Session-only thinking level applied before starting this prompt. */
	thinkingLevel?: ThinkingLevel;
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** RPC input: the connection declared `interactive_user`; without it the `input` event attributes it to an agent. */
	interactiveUser?: boolean;
	/**
	 * Send command-shaped text that no command handles to the model as plain text. Without it, such
	 * interactive or RPC input is rejected with `UnknownCommandError`.
	 */
	unknownCommandAsText?: boolean;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Internal hook used by the TUI to distinguish handled input from owned prompt work. */
	promptDisposition?: (disposition: PromptDisposition) => void;
	/** Internal cancellation signal for a prompt that has not acquired session-work ownership yet. */
	signal?: AbortSignal;
	/** Internal callback used by fire-and-forget extension input to retain session-work ownership after its barrier wait. */
	onSessionWorkReady?: () => void;
	sessionTitlePrompt?: string | false;
	onQueuedInput?: (input: PreparedClientInput) => void;
	/** Internal: the admitted native turn now owns the input, before agent_start. */
	onTurnAdmitted?: () => void;
	/** Arm the tool barrier for the turn this prompt starts; ignored when the prompt is queued instead (senpi#3717). */
	toolBarrier?: ToolBarrierSpec;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling used the configured favorite model list */
	isScoped: boolean;
	/** Models skipped because their usability budget cannot admit the current context. */
	skippedModels: readonly Model<any>[];
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
	/** Some turn had no known price, so `cost` is a lower bound (senpi#3844). */
	costUnknown?: true;
	contextUsage?: ContextUsage;
	/** Absent from hosts that predate the report. */
	failures?: SessionFailureReport;
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

/**
 * Cursor admission lives in its own module; the names stay exported here so
 * existing importers keep resolving them.
 */
export { CURSOR_TOOL_RESULT_MAX_CHARS, truncateToolResultBodies } from "./cursor-history-admission.ts";

// ============================================================================
// AgentSession Class
// ============================================================================

export function providerRetryWatchdogAbortMessage(
	retryTimeoutMs: number | undefined,
	streamStartTimeoutMs: number | undefined,
): string {
	const waited = retryTimeoutMs === undefined ? "" : ` after ${Math.round(retryTimeoutMs / 1000)}s`;
	return (
		`The retried request never started streaming${waited}.` +
		(streamStartTimeoutMs === undefined
			? " (Its stream-start guard is off; to bound or extend this wait, set retry.provider.streamStartTimeoutMs, 0 disables.)"
			: ` (Stream-start guard: ${Math.round(streamStartTimeoutMs / 1000)}s; to allow longer, raise retry.provider.streamStartTimeoutMs, 0 disables.)`)
	);
}

/** Auth for a summarization or title request, resolved for the physical model. */
type SummarizationRequestAuth = {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	thinkingLevel: ThinkingLevel;
};

function isHumanInput(options: { source?: InputSource } | undefined): boolean {
	return inputOriginOf(options?.source) === "person";
}

function promptKind(options: PromptOptions | undefined): HumanInputAdmittedEvent["kind"] {
	if (options?.streamingBehavior === "steer") return "steer";
	if (options?.streamingBehavior === "followUp") return "follow_up";
	return "prompt";
}

/** Whether two batches carry the same items, in any order; duplicate ids count, so [a, a] is not [a, b]. */
function sameItems(a: readonly string[], b: readonly string[]): boolean {
	const left = [...a].sort();
	const right = [...b].sort();
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: SessionModelEntry[];
	private _favoriteModels: SessionModelEntry[];

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	/** The last repair of the session file, replayed to surfaces that attach before the next prompt (senpi#4295). */
	private _standingRecovery: Extract<AgentSessionEvent, { type: "session_recovered" }> | undefined;
	private _unsubscribeRecovery: (() => void) | undefined;
	readonly securityNotices = new SecurityNoticeSnapshot();
	private _unsubscribeSecurityNotices?: () => void;
	private _unsubscribeSettingsSource?: () => void;
	private _unregisterMemoryReport: () => void = () => {};
	private _eventListeners: AgentSessionEventListener[] = [];
	private readonly _structuredLane: StructuredSessionLane;
	private _agentEventQueue: Promise<void> = Promise.resolve();
	/**
	 * Exact message objects whose message_end persistence is still queued.
	 * Agent core appends messages to agent.state.messages before emitting
	 * message_end; until that event settles on _agentEventQueue, compaction must
	 * treat these identities as pending persistence, never as stale or droppable.
	 */
	private readonly _messageEndsAwaitingPersistence = new Set<AgentMessage>();
	/** Settles once the queued message_end processing (persistence included) of that exact message has run. */
	private readonly _messageEndPersistence = new WeakMap<AgentMessage, Promise<void>>();
	private _isAgentRunActive = false;
	private _promptsInFlight = 0;
	/** senpi#3650: the core may continue a run after agent_end; the settle must not wait on that continuation. */
	private readonly _runContinuations = new AgentRunContinuations();
	/** senpi#3650: the turn that owns extension handler waits started now; the turn deadline releases only its own. */
	private _handlerTurnScope = 0;
	private _toolExecutionDepth = 0;
	private readonly _toolContextDisposers = new Set<() => void>();
	private _promptStartPending = false;
	/** The pending start claim; `started` is set when it is released (true only for a turn about to start). */
	private _promptStartClaim: { started?: boolean; joined?: boolean } | undefined;
	/** The next scheduled continuation runs queued input, not the transcript tail (a failed start's joiners). */
	private _continueWithQueuedInput = false;
	/** True while a reload's `session_start` handlers run; a nested reload would retire the runner they run on. */
	private _sessionStartDispatching = false;
	/** Waiters for the moment no prompt start is pending and no session start is dispatching (applyProjectTrustChange). */
	private _admissionIdleWaiters: Array<() => void> = [];
	/** User-abort generation at the start of an idle trigger turn's awaited admission hooks. */
	private _triggerTurnAdmissionAbortGeneration: number | undefined;
	private _pendingCustomTurnHeaders = 0;
	private _engineTurnStarts: EngineTurnStartRecord[] = [];
	private _engineResumeWindow: boolean;
	private readonly _engineTurnHold: EngineTurnHold;
	private _lifecycleBinding: LifecycleSessionBinding;
	/** Itemized batches waiting for the entry their one message is written to (senpi#3811). */
	private readonly _persistWatchers = new WeakMap<object, PersistWatcher>();
	/**
	 * The entry a ticket's queued message was written as, kept only while a re-send that joined that queued message is
	 * still in flight, so a re-send that lost the race still gets its receipt. The last such re-send removes it, so the
	 * map holds at most one entry per in-flight re-send (senpi#4125 review).
	 */
	private readonly _writtenTicketEntries = new Map<string, string>();
	/** How many sends that joined each ticket's queued message are still in flight. */
	private readonly _carrierJoiners = new Map<string, number>();
	private _resumeSettlement: Promise<void> = Promise.resolve();
	private readonly _engineTurnRelease = new EngineTurnRelease();
	private readonly _engineTurnInput: EngineTurnInput;
	private readonly _humanInputListeners = new Set<(event: HumanInputAdmittedEvent) => void>();
	private readonly _heldInputs: HeldInputs;
	private readonly _runHolds: RunHolds;
	private readonly _resumeEffects = new Map<string, ResumeSessionAnswer>();
	private _stopInterrupt: StopInterrupt | undefined;
	private _deliveredHeldInputIds: string[] = [];
	private _heldCommandRun: Promise<void> | undefined;
	/** Held person input is captured synchronously but its skills are read asynchronously, so it waits here as a promise. */
	private readonly _releaseExtras: (CustomMessage | Promise<CustomMessage>)[] = [];
	private _releaseExtrasGeneration = 0;
	private _engineTurnPauseRecorded = false;
	// The pause warning is shown once per pause: a stream of refused events would otherwise add one line each (senpi#2537).
	private _engineTurnPauseNotified = false;
	private _nextInputId = 0;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;
	private _settlementEpoch = 0;
	/** Set by the idle release; every runtime read re-hydrates before handing the array out. */
	private _runtimeMessagesTokenized = false;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Queued-input ids a person enqueued (see `hasQueuedPersonInput`); stale ids are pruned on read. */
	private readonly _personQueuedIds = new Set<string>();
	/** Recovery-only order across both native queue modes and TUI compaction ownership. */
	private _queuedInputOrder: QueuedInput[] = [];
	/** The cause of the abort in flight, reported on the `agent_end` it produces. */
	private _abortCause: AgentAbortCause | undefined;
	private _nextQueuedInputOrder = 0;
	private _nextQueuedId = 0;
	/** Identified queued input (with a client id) in durable custody; see pending-input-session.ts (senpi#3549). */
	private readonly _pendingInputs: SessionPendingInputs;
	private _queueClearRecorded: Promise<void> = Promise.resolve();
	/** The exact message object queued for each `queuedId`, so removal and edits hit the native queue by identity. */
	private readonly _queuedMessages = new Map<string, AgentMessage>();
	/**
	 * Input source of each user message this session admitted, written onto its session entry when the
	 * message is persisted. Kept off the message itself so it can never reach a provider request.
	 */
	private readonly _userInputSources = new WeakMap<AgentMessage, InputSource>();
	// `queued` then `started` for input queued while a turn runs, keyed by the user message the queue hands over.
	private readonly _queuedInputDispositions = new QueuedInputDispositions((inputId, disposition) =>
		this._emitInputDisposition(inputId, disposition),
	);
	private readonly _queuedInputAges = new QueuedInputAges();
	/** Recently delivered `queuedId`s (bounded), so a late dequeue answers `already_delivered`, not `not_found`. */
	private readonly _deliveredQueuedIds = new Set<string>();
	private _sessionLogger: SessionLogger;
	/**
	 * A single notice slot for `compaction.model` fallbacks: a cause logs once, and logs again only
	 * after a different cause or a successful use of the override clears the slot.
	 */
	private _compactionModelFallbackNotice: string | undefined;
	private _activeCompactionLogAttempt:
		| { id: string; reason: CompactionReason; tokensBefore: number | undefined }
		| undefined;
	private readonly _supersededCompactionLogAttemptIds = new Set<string>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	private _pendingCustomMessages: CustomMessage[] = [];
	/** Deliveries from other sessions: admitted once into the queues below, tracked until their entry is written. */
	readonly externalAdmission = new ExternalAdmission({
		isBusy: () => this._isAgentRunActive || this._promptStartPending,
		enqueue: (message, lane) => (lane === "steer" ? this.agent.steer(message) : this.agent.followUp(message)),
		start: (message) =>
			this.sendCustomMessage(message, { triggerTurn: true }).catch((error: unknown) => {
				this._sessionLogger.warn("external_delivery_start_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}),
	});
	private _controlEndpointHost: ControlEndpointHost | undefined;
	/** The current extension generation's `pi.session`; a reload retires it with its runner. */
	private _sessionControl: GenerationSessionControlActions | undefined;
	private _relocationHost: SessionRelocationHost | undefined;
	// Queues held while the first post-compaction response is classified. Agent
	// core otherwise drains steering immediately before AgentSession can consume
	// the stale-usage exemption and schedule the continuation itself.
	private _postCompactionDeferredSteeringMessages: AgentMessage[] = [];
	private _postCompactionDeferredFollowUpMessages: AgentMessage[] = [];

	// Compaction state
	// Each abort controller below is an isCompacting fact; setting or clearing one is a lifecycle edge (senpi#3980).
	private _compactionAbortControllerValue: AbortController | undefined = undefined;
	private _autoCompactionAbortControllerValue: AbortController | undefined = undefined;
	private get _compactionAbortController(): AbortController | undefined {
		return this._compactionAbortControllerValue;
	}
	private set _compactionAbortController(controller: AbortController | undefined) {
		if (this._compactionAbortControllerValue === controller) return;
		this._compactionAbortControllerValue = controller;
		this.refreshLifecycle();
	}
	private get _autoCompactionAbortController(): AbortController | undefined {
		return this._autoCompactionAbortControllerValue;
	}
	private set _autoCompactionAbortController(controller: AbortController | undefined) {
		if (this._autoCompactionAbortControllerValue === controller) return;
		this._autoCompactionAbortControllerValue = controller;
		this.refreshLifecycle();
	}
	private _pendingCompactionAdmission: PendingCompactionAdmission | undefined = undefined;
	private readonly _compactionLifecycle = new CompactionLifecycleCoordinator();
	// Work held by the barrier is a lifecycle fact: its release is an edge (senpi#3980).
	private readonly _sessionWorkBarrier = new SessionWorkBarrier(() => this.refreshLifecycle());
	/**
	 * Extension-published activity that outlives a turn (background terminal
	 * jobs, terminal monitors, loop-guard holds). Counts persist across extension
	 * reloads on purpose: a stale "busy" only delays reclamation, while a lost
	 * one would let the host evict a session still doing work.
	 */
	private readonly _wakeSources = new WakeSourceTracker();
	private _unsubscribeWakeSources: (() => void) | undefined;
	private _overflowRecoveryRungs = 0;
	private _autoCompactionSessionOverride: boolean | undefined;
	private _compactionSkippedTooSmall = false;
	private _requiredCompactionAdmissionError: RequiredCompactionError | undefined;
	// Message writes the session file refused. Queued event work cannot throw to the prompt, so a
	// prompt-owned run's prompt throws the first one once the queue settles; any other run reports it
	// as a continuation error when it happens.
	private readonly _transcriptWriteFailures = new TranscriptWriteFailures();
	private readonly _recoveryIdentity = compactUpdatesEnabled() ? new SessionRecoveryIdentity(undefined, this) : undefined;
	private _promptOwnsRun = false;
	// Preserve provenance across agent-core's conversion of our admission error
	// into an assistant error message. Matching provider text alone is not proof
	// that AgentSession initiated required-compaction recovery.
	private _requiredCompactionTurnError: RequiredCompactionError | undefined;
	private _resumeCompactionRequirement: ResumeCompactionRequirement | undefined;
	private _pendingModelSwitch: PendingModelSwitch | undefined;
	private _resumeSlice: ResumeSlicePlan | undefined;
	// A retry continuation immediately follows an accepted compaction. Its first
	// response must not retrigger threshold compaction from stale provider usage.
	private _skipNextPostRetryCompactionCheck = false;
	/**
	 * Armed when an accepted compaction produced a summary that still leaves the
	 * context over budget. It survives synthetic revision bumps (model or settings
	 * changes, queue mutation, extension continuations, scheduled retries) because
	 * none of those change the context that was rejected; only a real reduction, a
	 * new user prompt, or a manual compaction releases it (#7921 case 6).
	 */
	private _blockedPostCompactionAssistant: { assistant: AssistantMessage; contentTokens: number } | undefined;
	private _delegatedCompactionKey: { provider: string; id: string } | undefined;
	private _skipNextPostCompactionAssistantCheck = false;
	private _scheduledContinuationRecompacted = false;
	private readonly _assistantsPendingAtCompaction = new WeakSet<AssistantMessage>();
	private readonly _postCompactionUsageExemptAssistants = new WeakSet<AssistantMessage>();
	private _messageRevision = 0;

	// Branch summarization state
	// Only the end of a tree navigation is a lifecycle edge. Its start is not: a lifecycle record written while the
	// navigation runs would become the session leaf under it, so the navigation would land on, or cancel to, the
	// wrong entry. The navigation is the person's own foreground action, so the session keeps its settled state
	// until it ends (senpi#4120).
	private _branchSummaryAbortControllerValue: AbortController | undefined = undefined;
	private get _branchSummaryAbortController(): AbortController | undefined {
		return this._branchSummaryAbortControllerValue;
	}
	private set _branchSummaryAbortController(controller: AbortController | undefined) {
		if (this._branchSummaryAbortControllerValue === controller) return;
		this._branchSummaryAbortControllerValue = controller;
		if (controller === undefined) this.refreshLifecycle();
	}

	private _sessionTitleAbortController: AbortController | undefined = undefined;
	private _sessionTitlePromise: Promise<void> | undefined = undefined;
	private readonly _autoTitleSessions: boolean;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private readonly _requestShapeRecovery = new RequestShapeRecovery();
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	private _failedResponse: AssistantMessage | undefined;

	/**
	 * Resolve the effective retry profile for the current model's provider.
	 * Falls back to the senpi-default profile when the provider declares none.
	 */
	private _resolveRetryProfile() {
		const providerId = this.model?.provider;
		const declared = providerId !== undefined ? this._modelRuntime.getProvider(providerId)?.retryPolicy : undefined;
		return this.settingsManager.resolveRetryProfile(
			providerId !== undefined ? { id: providerId, retryPolicy: declared } : undefined,
		);
	}
	private _probePhase: ProbePhase = "idle";
	private _hintDeadlineMs: number | undefined = undefined;
	private _cumulativeHintedWaitMs = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _userAbortPromise: Promise<void> | undefined = undefined;
	private readonly _abortProvenance = new AgentAbortProvenance();
	private _deadlineTracker!: AgentDeadlineTracker;
	private readonly _agentSettledDelivery = new AgentSettledDelivery();
	private _suppressQueuedContinuationAfterUserAbort = false;
	private _userAbortGeneration = 0;
	/** Set when clearQueue({ abortWillFollow: true }) drains queues immediately before abort(). */
	private _hadClearedQueuedMessages = false;
	private _extensionEventSignal: AbortSignal | undefined = undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private readonly _toolDispatcher: ToolDispatcher;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private _prePromptProjection: { branch: SessionEntry[]; projection: SessionProjection } | undefined;
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	/** Assistant turns whose `turn_end` boundary committed entries, so the next request must re-read agent state. */
	private readonly _boundaryRefreshedTurns = new WeakSet<object>();
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	/** Set when dispose() starts; a turn still unwinding after it cannot resolve persisted entries (senpi#2995). */
	private _disposed = false;
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir: string;
	private readonly _toolChild: SessionToolChild | undefined;
	private readonly _toolChildHostTargets = new Map<RegisteredHostCallKind, HostCallTarget>();
	/** The composed filesystem policy the built-in file tools enforce; a tool child's `authorize` asks the same one. */
	private _filesystemPolicy: FilesystemPolicyChecker | undefined;
	/** Settles once dispose() has stopped the tool child, swept what it launched, and closed its in-process offload jobs. */
	private _toolChildClosed: Promise<void> = Promise.resolve();
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _defaultToolNames?: Set<string>;
	private _usesDefaultTools = false;
	private _evalOnlyToolNames?: ReadonlySet<string>;
	/** Explicit config override; when supplied it wins over the fixed and declared policy across reloads. */
	private readonly _evalOnlyToolNamesOverride?: ReadonlySet<string>;
	/** Policy tools withheld from the model, retained so disarming can restore direct access. */
	private readonly _withheldEvalOnlyToolNames = new Set<string>();
	/** Eval-only hint names this session published, so a disarm can withdraw exactly those. */
	private readonly _publishedEvalOnlyHintNames = new Set<string>();
	/** Active-tool selection as requested by callers, before eval-only filtering. */
	private _requestedActiveToolNames?: string[];
	/** Every tool that has been active this session, in first-activation order (senpi#2095). */
	private readonly _declaredToolNames: string[] = [];
	/** Tool names the base system prompt was last built from. */
	private _promptToolNames: readonly string[] = [];
	/** Whether the last tool declaration used the session-wide declared set. */
	private _promptDeclaresSessionTools = false;
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	// Settles once session_start handlers, default-tool enforcement, and resource discovery
	// (which rebuilds the base prompt with discovered skills) have run.
	private _sessionStartSettled: Promise<void> = Promise.resolve();
	private readonly _promptCachePrefixBuilds = new PromptCachePrefixBuilds();
	private readonly _userActivity = createUserActivitySource();
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
	private _providerRequiredNoticed = false;
	private readonly _retryFallback: RetryFallbackController;
	private readonly _modelConfigErrors: ModelConfigErrorReporter;
	private readonly _selectorCooldowns: SelectorCooldowns;
	private readonly _fallbackCircuits: FallbackCircuitAccess;
	private readonly _fallbackCircuitsLease: ReturnType<typeof acquireFallbackCircuits>;
	private _probeBackLaneSeq = 0;
	private _circuitProbeWatchdog: ReturnType<typeof setTimeout> | undefined;
	private readonly _probeBackScheduler: ProbeBackScheduler;
	private readonly _fallbackNow: () => number;
	private readonly _retryRandom: () => number;
	private readonly _environmentContextEnabled: boolean;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _lazyToolActivation = new LazyToolActivation({
		getToolDefinition: (name) => this.getToolDefinition(name),
		getActiveTools: () => this.getActiveToolNames(),
		setActiveTools: (names) => this.setActiveToolsByName(names),
	});
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	private readonly _toolBarrier = new ToolBarrier((spec) => this._emit({ type: "tool_barrier_expired", ...spec }));
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _currentServiceTier: ServiceTier | undefined = undefined;
	private _sessionFastMode = false;
	private readonly _shownHighReasoningWarningKeys = new Set<string>();
	private readonly _shownThinkingClampWarningKeys = new Set<string>();
	private readonly _startupThinkingClamp: ThinkingClampNotice | undefined;
	/** Last manual preference for unremembered models, kept in the session rather than startup config. */
	private _lastManualThinkingLevel: ThinkingLevel | undefined;
	private _thinkingLevelSource: ThinkingLevelSource;
	private readonly _sessionThinkingMemory: SessionThinkingMemory;
	// Widened with the upstream BuildSystemPromptOptions user-override fields so
	// extensions (prompt-preset) can see CLI/SDK custom prompts via
	// before_agent_start/model_select systemPromptOptions and ctx.getSystemPromptOptions().
	private _baseSystemPromptOptions!: BuildDynamicSystemPromptOptions & {
		customPrompt?: string;
		appendSystemPrompt?: string;
	};
	private _baseSystemPromptParts: readonly DynamicSystemPromptPart[] = [];
	private _sizesOnlyStartup = false;
	private _promptSizeInventory: PromptSizeInventory | undefined;
	private _systemPromptOverride?: string;
	private _promptSurface: PromptSurface | undefined;
	private _browserEngine: BrowserEngine | undefined;
	private readonly _sessionEnv: Readonly<Record<string, string>> | undefined;

	constructor(config: AgentSessionConfig) {
		this._promptSurface = config.promptSurface;
		this._browserEngine = config.browserEngine;
		this._sessionEnv = config.sessionEnv;
		this.agent = config.agent;
		this._structuredLane = new StructuredSessionLane(
			config.internalChannel,
			(deliver) => {
				if (!this._unsubscribeAgent) return;
				this._agentEventQueue = this._agentEventQueue.then(deliver, deliver);
			},
			(control) => this._recoveryIdentity?.own(control),
		);
		this.sessionManager = config.sessionManager;
		this._unsubscribeRecovery = this.sessionManager.onRecovery((recovery) => {
			this._standingRecovery = { type: "session_recovered", ...recovery };
			this._emit(this._standingRecovery);
		});
		this._sessionThinkingMemory = new SessionThinkingMemory(config.sessionManager);
		this._thinkingLevelSource = config.initialThinkingLevelSource ?? "default";
		this._pendingInputs = new SessionPendingInputs({
			sessionManager: this.sessionManager,
			nextQueuedId: () => this._mintQueuedId(),
			onChange: (update) => this._emit({ type: "pending_input_update", ...update }),
		});
		const queuedInputPort = this._pendingInputs.queuedInputPort();
		this.agent.queuedInputPort = {
			...queuedInputPort,
			// A follow-up the core drains starts a new turn, inside the same run: the armed turn's barrier ends here.
			commitConsumption: (queue, messages) => {
				if (queue === "followUp") this._toolBarrier.clear();
				return queuedInputPort.commitConsumption(queue, messages);
			},
		};
		this.settingsManager = config.settingsManager;
		this._unsubscribeSettingsSource = this.settingsManager.subscribeToSourceSelection((source) => {
			this._emit({ type: "settings_source_selected", ...source });
		});
		const noModelFallback =
			config.resourceLoader.getExtensions().runtime.flagValues.get("no-model-fallback") === true ||
			envValue("NO_FALLBACK") === "1";
		if (noModelFallback) {
			this.settingsManager.applyOverrides({ retry: { modelFallback: false } });
		}
		if (config.resourceLoader.getExtensions().runtime.flagValues.get("no-ask-user") === true) {
			this.settingsManager.applyOverrides({ askUser: { enabled: false } });
		}
		this._scopedModels = config.scopedModels ?? [];
		this._favoriteModels = config.favoriteModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this.securityNotices.setResources(this._resourceLoader.getSkills().diagnostics);
		this._unsubscribeSecurityNotices = this._resourceLoader.onExtensionEvent?.("security_notice", (value) =>
			this.securityNotices.accept(value),
		);
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
		this._modelConfigErrors = createModelConfigErrorReporter(fallbackLogger, (event) => this._emit(event));
		this._sessionLogger = createSessionLogger(this._agentDir, {
			context: () => ({
				sessionId: this.sessionManager.getSessionId(),
				provider: this.model?.provider,
				model: this.model?.id,
			}),
		});
		const toolRuntime = config.toolRuntime ?? "in-process";
		const hostRefusal = toolRuntimeHostRefusal(toolRuntime);
		if (hostRefusal !== undefined) throw new ToolRuntimeUnsupportedHostError(hostRefusal);
		// One host-call handler for both runtimes: the child's reverse bridge and an in-process ctx.offload module.
		const hostCalls = createSessionHostCallHandler({
			cwd: this._cwd,
			executeNested: (parentToolCallId, name, args, signal) =>
				this._executeNestedToolCall(parentToolCallId, name, args, { signal }),
			callableToolNames: () => this._callableToolNames(),
			target: (kind) => this._toolChildHostTargets.get(kind),
			filesystemPolicy: () => this._filesystemPolicy,
		});
		this._toolChild =
			toolRuntime === "child"
				? new SessionToolChild({
						dir: join(this._agentDir, "tool-children", this.sessionManager.getSessionId()),
						cwd: this._cwd,
						moduleRoots: () => [
							...toolChildModuleRoots(this._extensionRunner.getAllRegisteredTools()),
							...childModuleRoots(this._extensionRunner.getAllChildModules()),
						],
						onRecord: (record) => {
							this._emit({ type: "session_tool_child", ...record });
							if (record.state === "exited")
								for (const job of this._childJobs()) job.childExited?.(record.generation);
						},
						onHostCall: hostCalls,
						onWake: (wake) => {
							for (const job of this._childJobs())
								if (job.kind === wake.source) job.wake?.(wake.value, wake.generation);
						},
					})
				: undefined;
		this._toolDispatcher = createToolDispatcher({
			runtime: toolRuntime,
			notify: (event, data) => this._sessionLogger.info(event, data),
			hostCalls,
			onModuleStuck: (notice) => {
				this._sessionLogger.warn("offload_module_stuck", {
					modulePath: notice.modulePath,
					export: notice.export,
					deadlineMs: notice.deadlineMs,
					files: notice.files,
				});
				this._emit({ type: "offload_module_stuck", ...notice });
			},
			...(this._toolChild === undefined
				? {}
				: { childRunner: this._toolChild.runner, childKindRunner: this._toolChild.kindRunner }),
		});
		this._fallbackValidationWarnings = validateFallbackChains(
			this.settingsManager.getRawFallbackChains(),
			this._modelRegistry,
		);
		// `source` names the scope that supplied the chains so a single log line
		// points at the file to open; "default" means no scope configured any.
		const fallbackChainsSource = this.settingsManager.getFallbackChainsScope() ?? "default";
		for (const warning of this._fallbackValidationWarnings) {
			fallbackLogger.warn("validation_warning", {
				warning,
				source: fallbackChainsSource,
			});
		}
		// senpi#2395: a clamp applied while the session was created is shown once by the mode that starts it.
		this._startupThinkingClamp = getThinkingClampNotice(this.agent.state.thinkingSelection, this.agent.state.model);
		if (this._startupThinkingClamp) {
			this._shownThinkingClampWarningKeys.add(this._thinkingClampWarningKey(this._startupThinkingClamp));
		}
		// Cooldowns, probe schedules, and circuits measure elapsed time, so they all
		// run on the monotonic clock; a wall-clock jump never parks or releases an entry.
		this._fallbackNow = config.fallbackNow ?? monotonicNow;
		this._selectorCooldowns = new SelectorCooldowns(
			this._fallbackNow,
			undefined,
			config.fallbackWallNow ?? config.fallbackNow ?? Date.now,
		);
		const lease = () => this._fallbackCircuitsLease;
		this._fallbackCircuits = createFallbackCircuitAccess({
			// Read on every use: the hold is taken as construction's last step.
			get breaker() {
				return lease().breaker;
			},
			owner: () => this.sessionId,
			now: this._fallbackNow,
			wallNow: config.fallbackWallNow ?? config.fallbackNow ?? Date.now,
			settings: () => this.settingsManager.getFallbackCircuitSettings(),
			logger: fallbackLogger,
		});
		this._retryRandom = config.retryRandom ?? Math.random;
		this._environmentContextEnabled = config.environmentContext ?? true;
		this._retryFallback = new RetryFallbackController({
			getSettings: () => this.settingsManager.getRetryFallbackSettings(),
			registry: this._modelRegistry,
			cooldowns: this._selectorCooldowns,
			circuits: this._fallbackCircuits,
			logger: fallbackLogger,
			switchModel: async (model, thinking, reason) => {
				await this._switchActiveModel(model, {
					persistDefault: false,
					appendSessionEntry: true,
					entryReason: reason,
					origin: { source: reason },
					emitModelSelect: true,
					modelSelectSource: reason,
					invalidateCompaction: true,
					ephemeralThinkingLevel: thinking,
					allowDeferral: false,
					repairWithSlice: true,
				});
			},
			isCandidateRefusal: (error) => error instanceof ModelUsabilityBudgetError,
			emit: (event) => this._emit(event),
			getCurrentSelector: () => (this.model ? { model: this.model, thinkingLevel: this.thinkingLevel } : undefined),
			isAuthAvailable: (provider) => this._modelRuntime.hasConfiguredAuth(provider),
		});
		this._probeBackScheduler = new ProbeBackScheduler({
			now: this._fallbackNow,
		});
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._defaultToolNames = config.defaultToolNames ? new Set(config.defaultToolNames) : undefined;
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		this._evalOnlyToolNamesOverride = config.evalOnlyToolNames ? new Set(config.evalOnlyToolNames) : undefined;
		this._evalOnlyToolNames = this._resolveEvalOnlyToolNames();
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? {
			type: "session_start",
			reason: "startup",
		};
		this._engineResumeWindow = this._sessionStartEvent.attended === false;
		this._engineTurnHold = new EngineTurnHold(
			this.sessionManager.reduceHistory(engineTurnHoldHistory),
			this._sessionStartEvent.attended === false,
			(type, data) => {
				const entryId = this.sessionManager.appendCustomEntry(type, data);
				this._emitEntryAppended(entryId);
				return entryId;
			},
			(message) => this._extensionRunner.getUIContext().notify(message, "info"),
			(event) => {
				this._emit(event);
				if (event.type === "session_paused" || event.type === "session_resumed") this._emitHoldChanged(event);
			},
		);
		this._engineTurnInput = new EngineTurnInput(this._engineTurnHold);
		this._runHolds = new RunHolds(this._engineTurnHold);
		for (const [effectId, answer] of this.sessionManager.reduceHistory(resumeEffectHistory))
			this._resumeEffects.set(effectId, answer);
		this._heldInputs = new HeldInputs(this.sessionManager.reduceHistory(heldInputHistory), (type, data) => {
			const entryId = this.sessionManager.appendCustomEntry(type, data);
			this._emitEntryAppended(entryId);
			return entryId;
		});
		this._lifecycleBinding = this._createLifecycleBinding();
		this._autoTitleSessions = config.autoTitleSessions ?? false;

		const initialModel = this.agent.state.model;
		if (initialModel) {
			const scopedMatch = this._scopedModels.find((sm) => modelsAreEqual(sm.model, initialModel));
			this._currentServiceTier = this._resolveServiceTier(
				initialModel,
				config.serviceTier ?? scopedMatch?.serviceTier,
			);
		}

		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentBoundaryHooks();

		try {
			this._buildRuntime({
				activeToolNames: this._initialActiveToolNames,
				includeAllExtensionTools: true,
			});
			this._deadlineTracker = new AgentDeadlineTracker(this, () =>
				resolveTurnDeadlineSettings({
					turn_inactivity_ms: this.settingsManager.getTurnInactivityMs(),
					turn_max_runtime_ms: this.settingsManager.getTurnMaxRuntimeMs(),
				}),
			);
			// Last, so a construction that throws never leaves a hold only dispose() could release.
			this._fallbackCircuitsLease = acquireFallbackCircuits(this._agentDir);
		} catch (error) {
			// dispose() is unreachable for a session whose constructor throws.
			this._releaseToolSearchService("session construction failed");
			throw error;
		}
		// A no-op unless SENPI_MEMORY_REPORT=1: the report reads these only when it is requested.
		this._unregisterMemoryReport = registerMemoryReportSession(this, {
			sessionId: () => this.sessionId,
			sessionFile: () => this.sessionManager.getSessionFile(),
			residentStore: () => this.sessionManager.getResidentStore().size(),
			reporters: () => this._extensionRunner.getMemoryReporters(),
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		extraBody?: Record<string, unknown>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
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
	 * functions may provide ambient credentials, unlike streamSimple. A virtual
	 * selection is routed first, so the summary is sized for the physical model.
	 */
	private async _getSummarizationRequestAuth(
		selectedModel: Model<any>,
		signal?: AbortSignal,
		callbacks?: RetryCallbacks,
	): Promise<SummarizationRequestAuth> {
		// Resolve a virtual selection once so auth retries cannot choose another model.
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					reason: "direct",
					thinkingLevel: this.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: this.thinkingLevel };
		return retryTransientCall(
			() => this._resolveSummarizationRequestAuth(model, thinkingLevel, signal),
			isOAuthRefreshUnavailableError,
			this.settingsManager.getRetrySettings(),
			signal,
			callbacks ?? this._summarizationRetryCallbacks({ source: "branchSummary" }),
		);
	}

	private async _resolveSummarizationRequestAuth(
		model: Model<any>,
		thinkingLevel: ThinkingLevel,
		signal?: AbortSignal,
	): Promise<SummarizationRequestAuth> {
		if (this.agent.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const storedResult = await this._modelRuntime.getAuth(model, { signal });
			const activeApiKey = await this.agent.getApiKey?.(model.provider);
			const result =
				activeApiKey !== undefined && storedResult?.source !== "OAuth"
					? await this._modelRuntime.getAuth(model, { apiKey: activeApiKey, signal })
					: storedResult;
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted || isOAuthRefreshUnavailableError(error)) throw error;
			return { model, thinkingLevel };
		}
	}

	/**
	 * Resolve the model used for compaction summarization. When the user sets a
	 * `compaction.model` override ("provider/model"), that model is used for the
	 * summarization call instead of the session model — this is what lets an
	 * SDK-owned lane (anthropic-subscription) compact on a cheaper/different model.
	 * Unset, malformed, unknown, spent, or credential-less overrides keep a usable session model;
	 * a set override that cannot serve logs why the session model was used.
	 * A spent account instead uses the held target or another authenticated model.
	 */
	private _resolveCompactionModel(sessionModel: Model<any>): Model<any> {
		const override = this._getCompactionSettings().model;
		const slash = override?.indexOf("/") ?? -1;
		const configured =
			override && slash > 0
				? this._modelRuntime.getModel(override.slice(0, slash), override.slice(slash + 1))
				: undefined;
		const usable = (model: Model<any>): boolean => !this._retryFallback.isProviderSpent(model.provider);
		// Preserve the explicit override and original-model geometry on healthy sessions.
		// A held downswitch uses its target only when the original account cannot serve.
		if (usable(sessionModel)) {
			if (!override) return sessionModel;
			const fallbackReason = !configured
				? slash > 0
					? "unknown_model"
					: "malformed"
				: !usable(configured)
					? "provider_spent"
					: this._modelRuntime.hasFreshAvailabilitySnapshot() &&
							!this._modelRuntime.hasConfiguredAuth(configured.provider)
						? // Only a published availability pass can say "no credentials": before it (or
							// after a busy store read) the answer is unknown, the override is kept, and
							// request-time auth decides.
							"no_credentials"
						: undefined;
			if (configured && fallbackReason === undefined) {
				this._compactionModelFallbackNotice = undefined;
				return configured;
			}
			if (fallbackReason) this._logCompactionModelFallback(override, fallbackReason, sessionModel);
			return sessionModel;
		}
		const pending = this._pendingModelSwitch?.model;
		if (pending && usable(pending)) return pending;
		if (configured && usable(configured)) return configured;
		const requiredContextWindow =
			estimateMessagesTokens(filterContextExcludedMessages(this._runtimeMessages())) +
			this._getCompactionSettings().reserveTokens;
		const available = this._modelRuntime
			.getModels()
			.find(
				(model) =>
					usable(model) &&
					model.contextWindow >= requiredContextWindow &&
					this._modelRuntime.hasConfiguredAuth(model.provider),
			);
		if (available) return available;
		throw new AccountUsageLimitError(sessionModel.provider, this._retryFallback.accountError(sessionModel.provider));
	}

	private _logCompactionModelFallback(
		override: string,
		reason: "malformed" | "unknown_model" | "provider_spent" | "no_credentials",
		sessionModel: Model<any>,
	): void {
		const notice = `${override}\u0000${reason}`;
		if (this._compactionModelFallbackNotice === notice) return;
		this._compactionModelFallbackNotice = notice;
		this._sessionLogger.warn("compaction_model_fallback", {
			model: override,
			reason,
			to: `${sessionModel.provider}/${sessionModel.id}`,
		});
	}

	private async _getCompactionRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
		callbacks?: RetryCallbacks,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		extraBody?: Record<string, unknown>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		const auth = await this._getSummarizationRequestAuth(model, signal, callbacks);
		return {
			...auth,
			extraBody: this._modelRuntime.getCompatibilityRequestConfig(model).extraBody,
		};
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id, undefined, undefined, undefined, {
			origin: { source: "restore" },
			duringTurn: false,
		});
	}

	/** The model whose limits apply to the conversation. */
	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
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

	/** The tool-search service of the current extension generation; undefined when the builtin is not loaded. */
	private _toolSearchService: ToolSearchService | undefined;

	/** Own the service the new extension load created and retire the previous generation's one. */
	private _adoptToolSearchService(extensionLoad: object): void {
		const next = adoptToolSearchServiceForSession(extensionLoad);
		if (this._toolSearchService !== next) this._toolSearchService?.dispose(this.sessionId, "replaced by a reload");
		this._toolSearchService = next;
	}

	private _releaseToolSearchService(reason: string): void {
		this._toolSearchService?.dispose(this.sessionId, reason);
		this._toolSearchService = undefined;
	}

	/**
	 * Let tool_search answer a query that names an eval-only or removed tool with that
	 * tool's redirect hint. Idempotent: called at construction and again once the
	 * extension runtime is bound and this session owns its service.
	 */
	private _bindToolSearchRemovedHints(): void {
		this._toolSearchService?.bindRemovedToolHints(() => this.agent.removedToolHints);
	}

	private _installAgentToolHooks(): void {
		this.agent.resolveUnknownToolCall = (toolName) => {
			const resolvedName = resolveToolNameAlias(toolName, this._callableToolNames());
			if (resolvedName === undefined || !this._activateLazyTool(resolvedName)) return undefined;
			return this.agent.state.tools.find((tool) => tool.name === resolvedName);
		};
		this._bindToolSearchRemovedHints();

		this.agent.beforeToolCall = async ({ toolCall, args }, signal) => {
			this._toolExecutionDepth++;
			try {
				const result = await this.preflightToolCall(toolCall, args, { signal });
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
				const override = await this._emitAfterToolCallHooks(toolCall, args, result, isError);
				return markInterrupted(this._stopInterrupt, isError, result.details, override);
			} finally {
				this._toolExecutionDepth--;
			}
		};
	}

	async preflightToolCall(
		toolCall: AgentToolCall,
		args: unknown,
		options: { waitForEventQueue?: boolean; parentToolCallId?: string; signal?: AbortSignal } = {},
	) {
		if (options.waitForEventQueue !== false) {
			await this._agentEventQueue;
		}
		const signal = options.signal ?? this.agent.signal;
		// A call released by Stop never runs: block it without asking its hooks (a permission prompt) about it.
		// Callers such as executeTool only honor an explicit block, so returning nothing here would let it run.
		if ((await this._waitForToolBarrier(toolCall, signal)) && signal?.aborted) {
			return { block: true, reason: "Operation aborted" };
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
				...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
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
		parentToolCallId?: string,
	) {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;
		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `search` or `eval` tool (upstream `deferred`/`codemode`). `model-only` and `hidden` tools are
	 * never callable from other tools.
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "search" || exposure === "eval" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					// A nested call runs inside its caller's execution: waiting on the event queue here
					// could wait on the caller's own tool_execution_start processing.
					beforeToolCall: ({ toolCall: call, args: callArgs }, callSignal) =>
						this.preflightToolCall(call, callArgs, {
							waitForEventQueue: false,
							parentToolCallId: parentId,
							signal: callSignal,
						}),
					afterToolCall: ({ toolCall: call, args: callArgs, result, isError }) =>
						this._emitAfterToolCallHooks(call, callArgs, result, isError, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/**
	 * Route a virtual model selection for each provider request (D-15). The request keeps the
	 * context the fork loop built (resident materialization, transformContext, admission); only
	 * the model and thinking level of a virtual selection are replaced by the routed physical
	 * model for this request. The selection itself stays in agent state.
	 */
	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const previous = (await previousPrepareRequest?.(request, signal)) ?? undefined;
			const model = previous?.model ?? this.agent.state.model;
			this._requestSelectedModel = selectedModelOf(
				this._retryFallback.activeState?.originalSelector,
				this._modelRegistry,
				model,
			);
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			if (!isVirtualModel(model)) {
				// A request after a routed one in the same run still names the routed model.
				return request.model === model ? previous : { ...previous, model, thinkingLevel };
			}

			// A routing failure rejects, which ends the run with an error response. Only messages the
			// user wrote start a turn; extension messages can follow them, e.g. from before_agent_start.
			const context = previous?.context ?? request.context;
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				thinkingLevel,
				signal,
				failed,
				state,
			});
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				this._emitEntryAppended(this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data));
			}
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				// After dispose() the aborted response is never persisted, so a missing entry there is the shutdown.
				error: this._disposed
					? TURN_END_SKIPPED_AFTER_SHUTDOWN
					: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		this._commitBoundaryDrafts(boundary.entries);
		if (boundary.entries.length > 0) this._boundaryRefreshedTurns.add(message);
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	/**
	 * Consume the agent's `finishTurn` hook (D-16): `turn_end` extension boundaries run before the
	 * agent emits `turn_end`, and a boundary `continue` forces one more request.
	 */
	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			// Agent.emit does not await the fork's event queue, so this turn's message_end persistence may
			// still be queued; the boundary resolves persisted entry IDs, as upstream's awaited listeners allow.
			await Promise.all(
				[turn.message, ...turn.toolResults].map((message) => this._messageEndPersistence.get(message)),
			);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	/**
	 * Cursor states a model's real context ceiling on every conversation
	 * checkpoint. Once observed, it replaces the catalog guess on the live model
	 * so context usage, compaction thresholds and admission all size against the
	 * window the server will actually enforce.
	 */
	private _applyObservedCursorContextWindow(model: Model<Api>): void {
		const observed = getCursorContextLimit(model.id);
		if (observed === undefined || observed <= 0 || observed === model.contextWindow) return;
		const previous = model.contextWindow;
		model.contextWindow = observed;
		this._sessionLogger.info("cursor_context_window_observed", { modelId: model.id, previous, observed });
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			// The idle path tokenizes agent.state.messages in place; every provider
			// request re-hydrates here so tokens can never reach a model.
			this.sessionManager.getResidentStore().materializeInPlace(messages);
			const transformed = this._requestShapeRecovery.apply(
				previousTransformContext ? await previousTransformContext(messages, signal) : messages,
			);
			const model = this.model;
			if (model?.provider !== "cursor" && model?.provider !== "cursor-cli-oauth") return transformed;
			this._applyObservedCursorContextWindow(model);
			const budgetBytes = cursorAdmissionBudgetBytes(model.contextWindow);
			const admission = admitCursorHistory({
				messages: transformed,
				budgetBytes,
				convert: (candidate) => this.agent.convertToLlm(candidate) as Message[],
			});
			if (admission.blankedToolResults > 0) {
				this._sessionLogger.info("cursor_admission_truncated", {
					blankedToolResults: admission.blankedToolResults,
					bytesBefore: admission.bytesBefore,
					bytesAfter: admission.bytesAfter,
					budgetBytes,
				});
			}
			if (admission.overBudget) {
				// The request is still admitted: Cursor answers an oversized history
				// with a 0-token resource_exhausted, which the session layer compacts.
				this._sessionLogger.warn("cursor_admission_over_budget", {
					bytes: admission.bytesAfter,
					budgetBytes,
				});
			}
			return admission.messages ?? transformed;
		};

		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			// A settled turn leaves tokens in agent.state.messages (idle release); make
			// them readable again before any consumer (compaction admission, context
			// refresh, admission estimation) reads them this turn.
			this._runtimeMessages();
			// Enforce compaction only when this prepare precedes an actual provider
			// admission: a tool continuation or queued steer/follow-up messages. A
			// completed turn with no continuation keeps pre-PR timing, while the
			// prior prepare callback and context refresh below still run every turn.
			const compactBeforeNextAdmission = async (): Promise<boolean> => {
				const provider = this.model?.provider;
				// Cursor rebuilds the full conversation each hop. Compacting here
				// mutates rootPrompt mid-run and poisons conversationId (#984).
				// Still truncate verbatim toolResult bodies so the skip cannot send MB-scale payloads (#1043).
				if (provider === "cursor" || provider === "cursor-cli-oauth") {
					return false;
				}
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
			// A committed turn_end boundary rebuilt agent state from the session projection (a handoff
			// compaction, context edits, custom messages); the loop's turn context predates that commit.
			const boundaryRefreshed = this._boundaryRefreshedTurns.delete(turn.message);
			const messages =
				compactedBeforeCallback || boundaryRefreshed ? this.agent.state.messages.slice() : turn.context.messages;

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
					context: {
						...turn.context,
						messages: this.agent.state.messages.slice(),
					},
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

			this._refreshToolDeclarationsForModel();
			return {
				...previousSnapshot,
				context: {
					...previousContext,
					messages: previousContext.messages,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
					declaredTools: this.agent.state.declaredTools?.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
				thinkingSelection: this.agent.state.thinkingSelection ?? null,
				abortServerSideFallback:
					this.settingsManager.getAbortServerSideFallback() && this._retryFallback.hasConfiguredChain(),
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/**
	 * Rebuild agent messages from the canonical session projection, keeping the exact messages still
	 * awaiting persistence (the fork restore path), and map projected messages to their entries.
	 */
	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this._restoreAgentMessagesFromSession();
		this._incrementMessageRevision();
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		// With no drafts the preview is the session itself; cloning the branch into a new manager
		// re-indexed and re-copied every entry twice per turn.
		const projection =
			drafts.length === 0
				? this.sessionManager.buildSessionProjection()
				: this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		if (drafts.length === 0) return;
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emitEntryAppended(entry.id);
	}

	/**
	 * Run `agent_before_settle` handlers where the run would otherwise settle. Returns whether the
	 * session continues: a handler asked for it (and the context can continue) or input is queued.
	 */
	private async _runBeforeSettleBoundary(heldQueue = false): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle"))
			return !heldQueue && this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			// Input the session held back before the boundary (an error turn, a retained required
			// compaction) stays held: only a handler's continue or newly queued input continues.
			const shouldContinue = result.continue || (!heldQueue && this.agent.hasQueuedMessages());
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	private _emitEntryAppended(entryId: string): void {
		if (this._extensionMode !== "rpc") return;
		const entry = this.sessionManager.getEntry(entryId);
		if (entry) this._emit({ type: "entry_appended", entry });
	}

	/** Append a transport-provided entry and publish it on the RPC event stream. */
	appendSessionEntry(entry: SessionEntry): void {
		this.sessionManager.appendEntry(entry);
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		this._emitEntryAppended(entry.id);
	}

	private _emit(event: AgentSessionEvent, captureSource: object = event): void {
		this._recoveryIdentity?.observe(event);
		const produced = event;
		if (
			event.type === "session_paused" ||
			event.type === "session_resumed" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end"
		)
			this.refreshLifecycle();
		this._logSessionEvent(event);
		if (event.type === "entry_appended") {
			event = { ...event, entry: describeUsageLimitEntry(event.entry) };
		}
		if (event.type === "retry_fallback_exhausted" && usageLimitScope(event.lastError) === "account") {
			event = {
				...event,
				lastError: new AccountUsageLimitError(this.model?.provider ?? "", event.lastError).message,
			};
		}
		if (event.type === "agent_end") {
			event = {
				...event,
				messages: event.messages.map((message) =>
					message.role === "assistant" ? describeUsageLimitMessage(message) : message,
				),
			};
		}
		// Keep provider text on the engine message for classification and in session.log,
		// but publish only the existing user-facing description to clients.
		if (
			(event.type === "message_end" || event.type === "message_start" || event.type === "message_update") &&
			event.message.role === "assistant"
		) {
			const message = describeUsageLimitMessage(event.message);
			event =
				event.type === "message_update"
					? {
							...event,
							message,
							assistantMessageEvent: {
								...event.assistantMessageEvent,
								...("error" in event.assistantMessageEvent ? { error: message } : {}),
								...("partial" in event.assistantMessageEvent ? { partial: message } : {}),
							},
						}
					: { ...event, message };
		}
		carryRecovery(produced, event);
		// The canonical projection goes first: its acceptance unit waits for this event's legacy record (senpi#4272).
		if (this._structuredLane.active) this._structuredLane.emitEvent(event, captureSource);
		for (const l of [...this._eventListeners]) {
			l(event);
		}
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({
				type: "session_compact_failed",
				...event,
			});
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
			this._sessionLogger.warn("provider_error", {
				kind,
				error: message.errorMessage,
				provider: message.provider,
				model: message.model,
			});
		}
	}

	private _estimateCompactionLogTokens(source: "active" | "persisted"): number | undefined {
		try {
			const messages =
				source === "active" ? this._runtimeMessages() : this.sessionManager.buildSessionContext().messages;
			return estimateMessagesTokens(filterContextExcludedMessages(messages));
		} catch {
			return undefined;
		}
	}

	private _createToolContext(signal: AbortSignal | undefined) {
		const context = this._extensionRunner.createContext();
		const controller = new AbortController();
		const cancellation = signal ?? context.signal;
		const unsubscribe = this.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length > 0) controller.abort();
		});
		const dispose = () => {
			unsubscribe();
			cancellation?.removeEventListener("abort", dispose);
			this._toolContextDisposers.delete(dispose);
		};
		this._toolContextDisposers.add(dispose);
		cancellation?.addEventListener("abort", dispose, { once: true });
		if (cancellation?.aborted) {
			dispose();
		} else if (this._steeringMessages.length > 0) {
			// Subscribe before checking, without yielding: queued steering cannot fall in a gap.
			controller.abort();
		}
		Object.defineProperty(context, "steeringSignal", { value: controller.signal, enumerable: true });
		return { context, dispose };
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
			ordered: [...this._queuedInputOrder].sort((a, b) => a.enqueueOrder - b.enqueueOrder),
		});
	}

	private _incrementMessageRevision(): void {
		this._messageRevision++;
		// A revision bump alone is not evidence that the rejected context changed:
		// releasing here let a synthetic bump retry the unchanged oversized context
		// (#7921 case 6). Release only once the context actually shrank.
		this._releaseBlockedPostCompactionAdmissionIfReduced();
	}

	/**
	 * `agent.state.messages` with resident tokens hydrated, same array identity.
	 * The idle release tokenizes the runtime messages in place to let the resident
	 * store drop its hydrated copies; every reader that can run between two turns
	 * goes through here so a sentinel never reaches a consumer.
	 */
	private _runtimeMessages(): AgentMessage[] {
		if (this._runtimeMessagesTokenized) {
			this._runtimeMessagesTokenized = false;
			this.sessionManager.getResidentStore().materializeInPlace(this.agent.state.messages);
		}
		return this.agent.state.messages;
	}

	/** Byte-derived size of the context an admission decision would carry. */
	private _blockedAdmissionContentTokens(): number {
		return estimateMessagesTokens(filterContextExcludedMessages(this._runtimeMessages()));
	}

	/** A compaction that genuinely reduced the context clears the blocked state. */
	private _releaseBlockedPostCompactionAdmissionIfReduced(): void {
		const blocked = this._blockedPostCompactionAssistant;
		if (blocked === undefined) return;
		if (this._blockedAdmissionContentTokens() < blocked.contentTokens) {
			this._blockedPostCompactionAssistant = undefined;
		}
	}

	/**
	 * Unconditional release for manual `/compact`, the user's explicit remedy. An
	 * ordinary user prompt is deliberately not a release: it only adds context, so
	 * it cannot make the rejected context admissible, and the pre-prompt gate
	 * already owns its own fail-closed rejection for that route.
	 */
	private _releaseBlockedPostCompactionAdmission(): void {
		this._blockedPostCompactionAssistant = undefined;
	}

	getMessageRevision(): number {
		return this._messageRevision;
	}

	/** Resolved agent state directory for this session. */
	get agentDir(): string {
		return this._agentDir;
	}

	/** Resolves after dispose() once the tool child has exited and its launched groups are swept; awaited by disposers. */
	whenToolChildClosed(): Promise<void> {
		return this._toolChildClosed;
	}

	/** The `list_sessions` row of this session's tool child (senpi#3566); `none` under the in-process runtime. */
	toolChildRow(): SessionToolChildRow {
		return this._toolChild?.row() ?? { state: "none" };
	}

	/**
	 * Working directory this session resolves settings against — the same value extensions
	 * receive as `ctx.cwd`, so a host surface (RPC) reads project settings identically.
	 */
	get cwd(): string {
		return this._cwd;
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
		this._delegatedCompactionKey = undefined;
		this._incrementMessageRevision();
	}

	/**
	 * #1873 narrows #1378: a cycle silently passes over a candidate only when no
	 * reduction could ever make it serve. A candidate that one compaction would fix
	 * is landed on and held as a pending switch instead, because skipping it throws
	 * away the model the user was cycling towards.
	 */
	private _modelChangeWouldExhaustContext(
		model: Model<Api>,
	): ReturnType<typeof projectModelUsabilityBudget> | undefined {
		if (model.contextWindow <= 0) return undefined;
		const compaction = this._getCompactionSettings();
		const projection = projectModelUsabilityBudget({
			model,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			liveContextTokens: this._getDownswitchLiveContextTokens(model),
			compaction,
			includeSpeculationLead: false,
			admission: this._modelSwitchAdmission(),
		});
		if (projection.usable) return undefined;
		if (compaction.enabled && projection.verdict === "fits-after-compaction") return undefined;
		return projection;
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

	private async _emitAgentSettled(agentEnd?: AgentEvent): Promise<void> {
		if (
			this.agent.state.isStreaming &&
			(await this._runContinuations.idleOrContinued(agentEnd, () => this.agent.waitForIdle()))
		) {
			// The core continued this run with input queued during agent_end; that continuation settles it.
			this._abortProvenance.closeAgentEndBoundary();
			return;
		}
		if (!this._isAgentRunActive) {
			this._abortProvenance.closeAgentEndBoundary();
			this._resolveIdleWaitIfIdle();
			return;
		}
		this._isAgentRunActive = false;
		// The run is over, so the turn a barrier was armed for is too. agent_end keeps it across an
		// expected retry; a retry that is cancelled or declined settles here without another agent_end.
		this._toolBarrier.clear();
		this._warnQueuedInputOutlivingRun(agentEnd);
		// Before the settle and idle edges: the drain they wake may redeliver what this run's file refused.
		this.externalAdmission.observeRunSettled();
		let deferredActions: DeferredAgentSettledAction[] = [];
		let deferredTurnClaims: DeferredTurnClaim[] = [];
		this._agentSettledDelivery.begin(this._userAbortGeneration);
		const settlementEpoch = ++this._settlementEpoch;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
			if (this._abortProvenance.takeLateUserJoin()) await this._emitSessionAbort();
			({ actions: deferredActions, turnClaims: deferredTurnClaims } = this._agentSettledDelivery.finish(
				this._userAbortGeneration,
			));
		} finally {
			this._agentSettledDelivery.cancel();
			this._abortProvenance.closeAgentEndBoundary();
			this._resolveIdleWaitIfIdle();
		}
		for (const action of deferredActions) action();
		queueMicrotask(() => {
			void this._emitAgentIdleAfterDeferredTurns(settlementEpoch, deferredTurnClaims);
		});
	}

	/**
	 * Drops the session manager's materialized views while nothing runs, when a full-history view of a trimmed
	 * mirror is among them (senpi#3519). Unlike `releaseSettledSessionMemory`, nothing is tokenized in place, so a
	 * history read can call it while its answer, which may share message objects, is still unwritten.
	 */
	releaseFullHistoryView(): void {
		if (this._isAgentRunActive || this._sessionWorkBarrier.hasActiveWork) return;
		if (this.sessionManager.holdsMaterializedHistory()) this.sessionManager.dropMaterializedCaches();
	}

	/**
	 * Release the memoized session views and tokenize the runtime messages while nothing runs.
	 * Called when a run settles idle and after a resumed session's first render, which builds the
	 * views without any run settling afterwards.
	 */
	releaseSettledSessionMemory(): void {
		if (this._isAgentRunActive || this._sessionWorkBarrier.hasActiveWork) return;
		// A trimmed mirror bounds memory to the kept tail; a full-history view held across idle
		// would pin every entry of the file again, so it goes at idle like the views below.
		if (this.sessionManager.holdsMaterializedHistory()) this.sessionManager.dropMaterializedCaches();
		// Releasing frees memory only for strings the store already spilled to its blob
		// backing: a resident string is shared with the store, so tokenizing it hands
		// back nothing while costing every settled-time reader a re-materialization.
		if ((this.sessionManager.getResidentStoreStats().evictedCount ?? 0) > 0) {
			// Settling idle: release the memoized materialized session views. Materialized
			// entries pin the full persisted strings, so keeping the views between turns
			// holds the whole session text in resident memory while nothing runs.
			this.sessionManager.dropMaterializedCaches();
			// agent.state.messages holds the runtime copies of the same large strings the
			// views pinned. Tokenize them in place while idle; the next read re-materializes
			// them through _runtimeMessages(), and the next turn through the hooks above.
			this.sessionManager.getResidentStore().externalizeInPlace(this.agent.state.messages);
			this._runtimeMessagesTokenized = true;
		}
	}

	private async _emitAgentIdleAfterDeferredTurns(
		settlementEpoch: number,
		deferredTurnClaims: DeferredTurnClaim[],
	): Promise<void> {
		// Run settlement is a settle point even when a deferred turn or newer settlement takes over below.
		const settlingFirst = this._settleInputRelease();
		if (settlingFirst) await settlingFirst;
		const dispositions = await Promise.all(deferredTurnClaims.map((claim) => claim.disposition));
		if (dispositions.includes("started")) return;
		if (dispositions.includes("delegated") || this._sessionWorkBarrier.hasActiveWork) {
			await this._waitForSettledSessionWork();
		}
		if (settlementEpoch !== this._settlementEpoch) return;
		if (this._isAgentRunActive || this._sessionWorkBarrier.hasActiveWork) return;
		if (settledRepetitiveTurnPause(this.sessionManager.getBranch())) {
			try {
				this._emitEntryAppended(
					this.sessionManager.appendCustomEntry(ENGINE_PAUSED_ENTRY_TYPE, {
						reason: "repetition",
						rule: "repetitive-turns",
						customType: "ttsr-injection",
						at: Date.now(),
					}),
				);
			} catch (error) {
				this._sessionLogger.warn("engine_turn_record_write_failed", {
					entry: ENGINE_PAUSED_ENTRY_TYPE,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.releaseSettledSessionMemory();
		this._deadlineTracker.disarm();
		this._emit({ type: "agent_idle" });
		this._lifecycleBinding.controller.idle();
		// An input release admitted into a turn that was already streaming settles here, once the run settles.
		const settling = this._settleInputRelease();
		if (settling) await settling;
	}

	private async _promptAgent(
		messages: AgentMessage | AgentMessage[],
		{
			inputOrigin,
			deferredTurnClaim,
			onQueuedInput,
			onTurnAdmitted,
		}: {
			readonly inputOrigin: InputOrigin;
			readonly deferredTurnClaim?: DeferredTurnClaim;
			readonly onQueuedInput?: (input: PreparedClientInput) => void;
			/** Called once the turn is admitted: the human-input seam releases its admission hold here. */
			readonly onTurnAdmitted?: () => void;
		},
	): Promise<void> {
		if (this._lifecycleBinding.controller.requiresHumanContinuation)
			throw new Error("The previous run was interrupted. Human input or Resume is required before another turn.");
		deferredTurnClaim?.resolve("started");
		this._lifecycleBinding.prepareRun();
		if (!this._isAgentRunActive) {
			this.externalAdmission.beginTurn();
			this._queuedInputAges.noteRunStarted();
		}
		this._isAgentRunActive = true;
		onTurnAdmitted?.();
		// A new turn admitted: arm the inactivity lease and the hard max-runtime cap.
		this._deadlineTracker.arm();
		this._handlerTurnScope += 1;
		// A new prompt replaces any retry that compaction before it scheduled.
		this._failedResponse = undefined;
		this._recordSelection();
		this._requiredCompactionAdmissionError = undefined;
		this._transcriptWriteFailures.startRun();
		this._promptOwnsRun = true;
		if (!this.agent.state.isStreaming) {
			const withoutRefused = this._transcriptWriteFailures.takeRefusedOut(this.agent.state.messages);
			if (withoutRefused) {
				this.agent.state.messages = withoutRefused;
				this._incrementMessageRevision();
			}
		}
		this.agent.abortServerSideFallback =
			this.settingsManager.getAbortServerSideFallback() && this._retryFallback.hasConfiguredChain();
		try {
			await this.agent.prompt(messages);
			// AgentSession's subscriber intentionally queues event work instead of
			// blocking Agent core. Wait for this run's queued recovery decision
			// before reporting prompt completion to the caller.
			await this._agentEventQueue;
			this._promptOwnsRun = false;
			const requiredCompactionError = this._requiredCompactionAdmissionError;
			this._requiredCompactionAdmissionError = undefined;
			const transcriptWriteFailure = this._transcriptWriteFailures.takeReport();
			if (requiredCompactionError) {
				this._sessionLogger.warn("prompt_rejected", {
					stage: "admission",
					error: "RequiredCompactionError",
				});
				throw requiredCompactionError;
			}
			if (transcriptWriteFailure) throw transcriptWriteFailure.error;
		} catch (error) {
			this._promptOwnsRun = false;
			if (
				error instanceof Error &&
				error.message ===
					"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."
			) {
				const queuedMessages = Array.isArray(messages) ? messages : [messages];
				const userMessage = queuedMessages.find((message) => message.role === "user");
				const source = userMessage === undefined ? undefined : this._userInputSources.get(userMessage);
				// The caller was already told this input started; it now waits in the queue, so persist
				// it as queued input before it is enqueued, exactly like the regular queue path (source included).
				const prepared =
					userMessage?.role === "user"
						? {
								...readClientMessageIdentity(userMessage),
								text: userMessageText(userMessage.content),
								images:
									typeof userMessage.content === "string"
										? undefined
										: userMessage.content.filter((part) => part.type === "image"),
								mode: "steer" as const,
								enqueueOrder: this.reserveQueuedInputOrder(),
								...(source === undefined ? {} : { source }),
							}
						: undefined;
				if (prepared) onQueuedInput?.(prepared);
				for (const message of queuedMessages) this.agent.steer(message);
				if (prepared) {
					this._steeringMessages.push(prepared.text);
					const queuedId = this._recordQueuedInput(prepared.text, "steer", prepared, userMessage);
					if (inputOrigin === "person") this._personQueuedIds.add(queuedId);
					this._emitQueueUpdate();
				}
				return;
			}
			await this._emitAgentSettled();
			throw error;
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;
	private _requestSelectedModel: SelectedModel | undefined;
	private readonly _endSelectedModels = new WeakMap<AgentEvent, SelectedModel>();

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent, signal: AbortSignal): void => {
		this._recoveryIdentity?.observe(event);
		if (event.type === "agent_start") {
			this._lifecycleBinding.startRun();
			this._requestSelectedModel = undefined;
		}
		// Bind now: the core can start another run before this event's asynchronous delivery.
		const queuedEvent =
			event.type === "agent_start" ? { ...event, runId: this._lifecycleBinding.controller.ledger.runId } : event;
		// Bound at emission: the core can start the next run before the queue reaches this end (senpi#3864).
		if (event.type === "agent_end") {
			this._lifecycleBinding.bindTurnEnd(event);
			// Freeze before async delivery or a queued run can replace the dispatched selection.
			if (this._requestSelectedModel) this._endSelectedModels.set(event, this._requestSelectedModel);
		}
		this._lifecycleBinding.controller.observeActivity(event);
		if (event.type === "message_start") {
			try {
				const entryId = this._lifecycleBinding.consume(event.message);
				if (entryId) this._emitEntryAppended(entryId);
			} catch (error) {
				this._transcriptWriteFailures.record(event.message, error);
			}
		}
		this._runContinuations.observe(event);
		// Record the calls a tool made through ctx.executeTool() and their usage on its result message,
		// synchronously so the message carries them before any listener or persistence sees it.
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}

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
			// A retry owns the queue the same way: the retry handler drops the failed
			// assistant from agent state, so the core's post-run check would otherwise
			// see a user tail and drain queued steering into the doomed retry request.
			const willRetry = this._willRetryAfterAgentEnd(event.messages);
			if (requiredAutoCompaction || willRetry) {
				this.agent.suppressQueuedMessageDrain();
			}
			// The barrier belongs to the armed turn: it ends here, before the core drains any follow-up.
			if (!willRetry) this._toolBarrier.clear();
			// agent_before_settle (D-15) decides the post-run queue: it continues first (queued follow-ups
			// wait until that continuation would stop) or keeps input it cannot run. Input its handlers queue
			// must not start an agent-core drain run before the boundary commits.
			if (this._extensionRunner.hasHandlers("agent_before_settle")) {
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
			() => this._processAgentEvent(queuedEvent, signal),
			() => this._processAgentEvent(queuedEvent, signal),
		);
		this._agentEventQueue =
			pendingMessage !== undefined
				? processing.finally(() => {
						this._messageEndsAwaitingPersistence.delete(pendingMessage);
					})
				: processing;

		// Keep queue alive if an event handler fails, including the promise created
		// by finally() above. The originating prompt observes the stored admission
		// error after the queue settles; no rejection should become unhandled.
		const settled = this._agentEventQueue.catch(() => {});
		if (pendingMessage !== undefined) {
			this._messageEndPersistence.set(pendingMessage, settled);
		}
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
			(!this._isRetryableError(lastAssistant) &&
				!this._isHardErrorFallbackEligible(lastAssistant) &&
				!isCursorZeroTokenResourceExhausted(lastAssistant) &&
				!isCursorQuotaResourceExhausted(lastAssistant, this.model?.contextWindow ?? 0))
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

	/**
	 * Threshold checks measure the larger of the provider-reported context and
	 * the plain local-transcript estimate. Providers whose usage tracks a
	 * server-side summarized conversation (native Cursor checkpoints) can report
	 * a context far smaller than the transcript this client replays every turn,
	 * and that small figure must not hide a transcript already past the window.
	 */
	private _resolveThresholdContextTokens(directContextTokens: number): number {
		const messages = filterContextExcludedMessages(this._runtimeMessages());
		return resolveThresholdContextTokens(directContextTokens, estimateMessagesTokens(messages));
	}

	/**
	 * `compaction.enabled=false` disables proactive (threshold) compaction only.
	 * A provider-confirmed overflow is an error the session cannot progress past
	 * by any other route, so overflow recovery stays armed regardless (#1422).
	 */
	private _getAutoCompactionReason(message: AssistantMessage): "overflow" | "threshold" | undefined {
		const settings = this._getCompactionSettings();
		if (message.stopReason === "aborted") {
			return undefined;
		}

		const model = this.model;
		// Narrowed to the stale usage number itself: pre-boundary provenance does
		// not exempt a context whose own content already exceeds the policy.
		if (!model) return undefined;
		if (this._isAssistantFromBeforeLatestCompaction(message) && !this._exceedsPolicyByContentEstimate()) {
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
		const isOverflow =
			(isContextOverflow(message, model.contextWindow) && (sameModel || currentContextNeedsCompaction)) ||
			this._isCursorPayloadOverflow(message);
		if (isOverflow) {
			if (settings.enabled || isTurnStuckOnContextOverflow(message, model.contextWindow)) return "overflow";
			return undefined;
		}
		if (!settings.enabled) {
			return undefined;
		}

		let contextTokens: number;
		const directContextTokens = message.usage ? calculateContextTokens(message.usage) : 0;
		if (message.stopReason !== "error" && directContextTokens !== 0) {
			contextTokens = this._resolveThresholdContextTokens(directContextTokens);
		} else {
			const messages = filterContextExcludedMessages(this._runtimeMessages());
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
					// Drop only the stale usage number; the messages themselves still count.
					const contentTokens = estimateMessagesTokens(messages);
					return shouldCompact(contentTokens, model.contextWindow, settings) ? "threshold" : undefined;
				}
			}
			contextTokens = estimate.tokens;
		}

		return shouldCompact(contextTokens, model.contextWindow, settings) ? "threshold" : undefined;
	}

	/**
	 * Content measured by bytes, ignoring every provider usage number. The
	 * stale-usage exemptions below only claim that a usage figure measured before
	 * the accepted compaction boundary is not evidence of current pressure; they
	 * must not exempt the messages themselves, because fresh post-boundary content
	 * (a large tool result, late steering) is measurable without any usage report
	 * (#7921 case 5).
	 */
	private _exceedsPolicyByContentEstimate(): boolean {
		const model = this.model;
		if (!model) return false;
		const settings = this._getCompactionSettings();
		const contextTokens = estimateMessagesTokens(filterContextExcludedMessages(this._runtimeMessages()));
		return shouldCompact(contextTokens, model.contextWindow, settings);
	}

	private _hasPendingPostCompactionUsageExemption(message: AssistantMessage): boolean {
		return (
			this._skipNextPostCompactionAssistantCheck &&
			!this._assistantsPendingAtCompaction.has(message) &&
			this._overflowRecoveryRungs === 0
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
		this._releasePostCompactionDeferral();
		this._postCompactionUsageExemptAssistants.add(message);
		return true;
	}

	/**
	 * Disarm the post-compaction usage exemption and hand the input parked behind it back to the ordinary queues.
	 * Every path that spends the exemption goes through here, so none can leave that input parked (#4036).
	 */
	private _releasePostCompactionDeferral(): void {
		this._skipNextPostCompactionAssistantCheck = false;
		this._flushPostCompactionDeferredMessages();
	}

	/** The first response after a compaction spends the exemption however it ended; true when it was released here. */
	private _releaseSpentPostCompactionExemption(message: AssistantMessage): boolean {
		if (!this._hasPendingPostCompactionUsageExemption(message) || this._isAssistantFromBeforeLatestCompaction(message)) {
			return false;
		}
		this._releasePostCompactionDeferral();
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
		// A user abort suppresses the retry and compaction continuation (#9340).
		if (this._suppressQueuedContinuationAfterUserAbort) {
			return false;
		}
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
		// The same-model budget comes from the resolved profile so a provider-declared
		// budget (e.g. kimi-code's 9) is honoured; identical to settings.maxRetries for
		// providers without a profile.
		const turnMaxRetries = this._resolveRetryProfile().turn.maxRetries;

		const retryableError = this._isRetryableError(lastAssistant);
		if (isCursorZeroTokenResourceExhausted(lastAssistant)) {
			return true;
		}
		if (isCursorQuotaResourceExhausted(lastAssistant, this.model?.contextWindow ?? 0)) {
			return this._retryFallback.canTryFallback();
		}
		if (!retryableError && this._isHardErrorFallbackEligible(lastAssistant)) {
			return true;
		}

		if (!retryableError) {
			return false;
		}

		if (isClassifierRefusal(lastAssistant)) {
			return this._retryAttempt + 1 <= turnMaxRetries && this._retryFallback.canTryFallback();
		}

		if (this._retryAttempt + 1 > turnMaxRetries) {
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
			this._armCircuitProbeWatchdog();
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryRungs = 0;
			this._retryFallback.resetTurn();
			const messageText = userMessageText(event.message.content);
			// Image-only input has no text to match: find it by the message the queue handed to the agent (#3592).
			const imageOnlyQueued = messageText
				? undefined
				: this._queuedInputOrder.find((input) => this._queuedMessages.get(input.queuedId) === event.message);
			if (messageText || imageOnlyQueued !== undefined) {
				const { clientMessageId } = readClientMessageIdentity(event.message);
				const queued =
					imageOnlyQueued ??
					(clientMessageId === undefined
						? undefined
						: this._queuedInputOrder.find((input) => input.clientMessageId === clientMessageId));
				// Check steering queue first
				const steeringIndex =
					(clientMessageId === undefined && queued === undefined) || queued?.mode === "steer"
						? this._steeringMessages.indexOf(messageText)
						: -1;
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._removeQueuedInput(messageText, "steer", clientMessageId);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex =
						(clientMessageId === undefined && queued === undefined) || queued?.mode === "followUp"
							? this._followUpMessages.indexOf(messageText)
							: -1;
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._removeQueuedInput(messageText, "followUp", clientMessageId);
						this._emitQueueUpdate();
					}
				}
			}
			await this._queuedInputDispositions.delivered(event.message);
		}

		const agentEndWillRetry = event.type === "agent_end" && this._willRetryAfterAgentEnd(event.messages);
		// A cause belongs to the run it stopped: a new run drops a stale one, the aborted run's agent_end takes it.
		if (event.type === "agent_start") this._abortCause = undefined;
		// Abort provenance, not the last message's shape: a run stopped mid-tool ends on a toolUse message.
		const abortCause =
			event.type === "agent_end" && this.currentAbortSource !== undefined ? this._abortCause : undefined;
		if (abortCause !== undefined) this._abortCause = undefined;

		// Emit to extensions first. Agent event persistence is intentionally
		// asynchronous, so retain the source run signal while dispatching.
		this._extensionEventSignal = signal;
		try {
			await this._emitExtensionEvent(event, agentEndWillRetry);
		} finally {
			this._extensionEventSignal = undefined;
		}
		if (event.type === "agent_end" && this._abortProvenance.takeLateUserJoin()) await this._emitSessionAbort();
		// Notify all listeners
		const sessionEvent =
			event.type === "agent_end"
				? withProviderFailure(
						{
							...event,
							willRetry: agentEndWillRetry,
							...(this._deadlineTracker.current !== undefined
								? { aborted: true, abortSource: "system" as const, deadline: this._deadlineTracker.current }
								: {}),
							...(abortCause === undefined ? {} : { abortCause }),
						},
						this._endSelectedModels.get(event),
					)
				: event.type === "message_update"
					? withResolvedToolName(event, (name) => this.resolveToolCallName(name))
					: event;
		let consumedEntry: string | undefined;
		if (event.type === "message_end") {
			try {
				consumedEntry = this._lifecycleBinding.consumedEntry(event.message);
			} catch (error) {
				this._transcriptWriteFailures.record(event.message, error);
			}
		}
		this._recoveryIdentity?.hint(event, consumedEntry);
		this._emit(carryRecovery(event, sessionEvent), event);
		if (event.type === "agent_end") {
			if (this._abortProvenance.takeLateUserJoin()) await this._emitSessionAbort();
		}

		if (event.type === "message_update" && event.message.role === "assistant") {
			this._acceptCircuitProbeOnProgress(event.message, event.assistantMessageEvent);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			this._observeEngineTurnMessage(event.message);
			let entryId: string | undefined;
			try {
				const refusal = this._transcriptWriteFailures.refusal(event.message);
				if (refusal) throw refusal.error;
				// Check if this is a custom message from extensions
				if (event.message.role === "custom") {
					// Persist as CustomMessageEntry
					entryId =
						consumedEntry ??
						this.sessionManager.appendCustomMessageEntry(
							event.message.customType,
							event.message.content,
							event.message.display,
							event.message.details,
							{ recoveryOwner: recoveryCarrier(event) },
						);
					this._incrementMessageRevision();
					this.externalAdmission.observePersisted(event.message);
					this._recordWrittenTicket(event.message, entryId);
					this._takePersistWatcher(event.message)?.persisted(entryId);
				} else if (
					event.message.role === "user" ||
					event.message.role === "assistant" ||
					event.message.role === "toolResult"
				) {
					// Regular LLM message - persist as SessionMessageEntry
					entryId = this.sessionManager.appendOwnedMessage(event.message, {
						inputSource: this._userInputSources.get(event.message),
						recoveryOwner: recoveryCarrier(event),
					});
					this._emitEntryAppended(entryId);
					this._incrementMessageRevision();
					this.externalAdmission.observePersisted(event.message);
				}
			} catch (error) {
				// The session manager kept nothing, so the turn goes on; the run's owner reports it.
				const errorMessage = error instanceof Error ? error.message : String(error);
				// A refused delivery is settled, not left held: a held start would queue every later delivery.
				this.externalAdmission.observeRefused(event.message, errorMessage);
				this._takePersistWatcher(event.message)?.failed(error);
				this._sessionLogger.warn("transcript_write_failed", { role: event.message.role, error: errorMessage });
				this._transcriptWriteFailures.record(event.message, error);
				this._emit(carryRecovery(event, { type: "transcript_write_failed", role: event.message.role, errorMessage }));
				if (!this._promptOwnsRun) this._reportContinuationTranscriptFailure();
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				const succeeded =
					!assistantMsg.errorMessage &&
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					!isClassifierRefusal(assistantMsg);
				if (succeeded) this._retryFallback.noteServed(`${assistantMsg.provider}/${assistantMsg.model}`);
				if (succeeded && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryRungs = 0;
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
		let retryExhaustionAllowsQueuedContinuation = false;
		let allowsPostCompactionUsageExemptContinuation = false;
		let releasedExemptionAllowsQueuedContinuation = false;
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
			this._clearCircuitProbeWatchdog();
			// Billing and quota exhaustion make the entry unusable for every session,
			// whether or not the chain has a candidate left.
			if (
				msg.stopReason === "error" &&
				!this._isLocalFailure(msg) &&
				(isHealthExhaustionFailure(msg.errorMessage) || usageLimitScope(msg.errorMessage) === "account") &&
				this.model
			) {
				this._retryFallback.noteHealthFailure(this.model, this.thinkingLevel, { errorMessage: msg.errorMessage });
			}
			const requiredAutoCompaction = this._getRequiredAutoCompactionReason(msg);
			const retryAfterRequiredCompaction =
				requiredAutoCompaction !== undefined && this._isRequiredCompactionError(msg);

			const requestShape = this._requestShapeRecovery.decide(msg, this.model?.contextWindow ?? 0);
			if (requestShape === "not-request-shape") this._requestShapeRecovery.endStreak();
			if (
				requestShape !== "not-request-shape" &&
				!userAbortSuppressedQueuedContinuation &&
				this.settingsManager.getRetrySettings().enabled
			) {
				const requestShapeOutcome = await this._handleRequestShapeRejection(msg, requestShape);
				if (requestShapeOutcome === "continued") {
					this._abortProvenance.closeAgentEndBoundary();
					return;
				}
				retryContinuationBlocked ||= requestShapeOutcome === "blocked";
			}
			// Retry transient failures normally and eligible hard errors only through a fallback.
			const retryableError = requestShape === "not-request-shape" && this._isRetryableError(msg);
			const hardErrorFallbackEligible = this._isHardErrorFallbackEligible(msg);
			const cursorZeroTokenRe = isCursorZeroTokenResourceExhausted(msg);
			const cursorQuotaRe = isCursorQuotaResourceExhausted(msg, this.model?.contextWindow ?? 0);
			const claudeSdkSameModelRemint = this._isClaudeSdkSameModelRemintError(msg);
			const retryCanAdmitProvider =
				!userAbortSuppressedQueuedContinuation &&
				this.settingsManager.getRetrySettings().enabled &&
				(retryableError ||
					hardErrorFallbackEligible ||
					cursorZeroTokenRe ||
					cursorQuotaRe ||
					claudeSdkSameModelRemint);
			let compactedBeforeRetry = false;
			if (
				retryCanAdmitProvider &&
				requiredAutoCompaction &&
				!(requiredAutoCompaction === "threshold" && this._hasPendingPostCompactionUsageExemption(msg))
			) {
				this._retireFailedRetryAssistant(msg);
				compactedBeforeRetry = await this._runPrePromptCompaction(msg, true, requiredAutoCompaction, true);
				retryContinuationBlocked =
					!compactedBeforeRetry && !this._isCompactionDelegated() && !cursorQuotaRe && !hardErrorFallbackEligible;
			}

			let retryOutcome: "continued" | "blocked" | "not-handled" | "cancelled" = "not-handled";
			const retryOwnedDeferredQueue = DEFERRED_RETRY_QUEUE_OWNERS.has(this);
			DEFERRED_RETRY_QUEUE_OWNERS.delete(this);
			if (!retryContinuationBlocked && !userAbortSuppressedQueuedContinuation) {
				if (cursorZeroTokenRe) {
					retryOutcome = await this._handleRetryableError(msg, { sameModelRemint: true });
				} else if (cursorQuotaRe) {
					// Mid-turn Cursor errors may retain unpaired tool calls. Remove the
					// failed assistant before provider fallback so replay stays valid.
					this._retireFailedRetryAssistant(msg);
					retryOutcome = await this._handleRetryableError(msg, { hardErrorFallback: true });
				} else if (claudeSdkSameModelRemint) {
					retryOutcome = await this._handleRetryableError(msg, { sameModelRemint: true });
				} else if (retryableError) {
					retryOutcome = await this._handleRetryableError(msg);
				} else if (hardErrorFallbackEligible) {
					retryOutcome = await this._handleRetryableError(msg, {
						hardErrorFallback: true,
					});
				}
			}
			if (retryOutcome === "continued") {
				this._abortProvenance.closeAgentEndBoundary();
				return;
			}
			// A probe that failed with retries disabled still reopens its circuit; any
			// other ending without an accepted response (a user abort, a request-shaped
			// error) hands the probe back and leaves the circuit half-open.
			if (
				msg.stopReason === "error" &&
				this.model &&
				this._isRetryableError(msg) &&
				this._isCircuitProbeOnCurrentModel()
			) {
				this._retryFallback.noteHealthFailure(this.model, this.thinkingLevel, { errorMessage: msg.errorMessage });
			}
			this._retryFallback.probes.release();
			// Provider-timeout retries deliberately skip their first queue poll so
			// steering cannot be consumed by another doomed retry request. Once the
			// managed retry owner exhausts its budget, hand that retained queue back
			// to the normal scheduled-continuation path instead of parking it until
			// an unrelated later prompt arrives.
			retryExhaustionAllowsQueuedContinuation =
				!userAbortSuppressedQueuedContinuation &&
				retryOwnedDeferredQueue &&
				retryOutcome === "not-handled" &&
				(msg.stopReason === "error" || msg.stopReason === "aborted");

			if (retryOutcome === "not-handled" && msg.errorCause?.type === "model_config") {
				this._modelConfigErrors.report(msg, this.sessionManager.getSessionId());
			}
			if (retryOutcome === "not-handled" && cursorQuotaRe && msg.errorMessage) {
				msg.errorMessage = `${msg.errorMessage} (likely provider usage/quota exhaustion: conversation is well below the model context window)`;
			}
			if (retryOutcome === "not-handled" && msg.stopReason === "error" && msg.errorMessage) {
				const rejectedImages = rejectedImageSources(this.agent.state.messages, msg);
				if (rejectedImages.length > 0) {
					msg.errorMessage = `${msg.errorMessage} (the rejected image from ${rejectedImages.join(", ")} is left out of later requests; send your next message to continue)`;
				}
			}
			if (retryOutcome === "not-handled" && this._retryAttempt > 0 && msg.errorMessage) {
				const attempt = this._retryAttempt;
				this._retryAttempt = 0;
				this._resetHintTierState();
				this._emit({
					type: "auto_retry_end",
					success: false,
					attempt,
					// A user abort cancelled the pending retry, as an abort during backoff does.
					finalError: userAbortSuppressedQueuedContinuation ? "Retry cancelled" : msg.errorMessage,
				});
			}
			this._resolveRetry();
			retryContinuationBlocked ||= retryOutcome === "blocked";
			if (!retryContinuationBlocked && !userAbortSuppressedQueuedContinuation) {
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
					// A failed first response consumes the exemption but must not continue the run: input queued behind it
					// waits for the next prompt, exactly as after a failed response without a compaction (#4036).
					allowsPostCompactionUsageExemptContinuation =
						this._postCompactionUsageExemptAssistants.has(msg) && msg.stopReason !== "error" && msg.stopReason !== "aborted";
					if (allowsPostCompactionUsageExemptContinuation) {
						this._flushPostCompactionDeferredMessages();
					}
					// Released before the admission re-sample below, which would otherwise still read the armed
					// exemption's "threshold" placeholder and fail the prompt with a false RequiredCompactionError.
					if (this._releaseSpentPostCompactionExemption(msg)) {
						releasedExemptionAllowsQueuedContinuation = this._agentEndAllowsQueuedContinuation(event.messages);
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
			// The exemption covers only the first response after a compaction. A run that ends on that response
			// without consuming it (a blocked or exhausted retry, a user abort) has still spent it: the input parked
			// while that run started rejoins the ordinary queues, whose rules then decide when it runs, exactly as
			// for input queued in a run without a compaction (#4036).
			if (this._releaseSpentPostCompactionExemption(msg)) {
				releasedExemptionAllowsQueuedContinuation =
					!userAbortSuppressedQueuedContinuation && this._agentEndAllowsQueuedContinuation(event.messages);
			}
		}

		if (event.type === "agent_end") {
			this._flushPendingBashMessages();
			if (
				!launchedContinuation &&
				!retryContinuationBlocked &&
				(allowsQueuedContinuation ||
					allowsPostCompactionUsageExemptContinuation ||
					releasedExemptionAllowsQueuedContinuation ||
					retryExhaustionAllowsQueuedContinuation) &&
				this.agent.hasQueuedMessages()
			) {
				// A scheduled continuation owns the queue now; the stored admission
				// rejection from a superseded required compaction must not surface.
				this._requiredCompactionAdmissionError = undefined;
				this._scheduleContinuationAfterCurrentEvent();
				launchedContinuation = true;
			}
			// agent_before_settle (D-15): handlers may append entries or ask for one more request before
			// the run settles. A user abort or a blocked retry settles without it.
			if (
				!launchedContinuation &&
				!retryContinuationBlocked &&
				!userAbortSuppressedQueuedContinuation &&
				this._extensionRunner.hasHandlers("agent_before_settle") &&
				(await this._runBeforeSettleBoundary(this.agent.hasQueuedMessages()))
			) {
				this._requiredCompactionAdmissionError = undefined;
				this._scheduleContinuationAfterCurrentEvent();
				launchedContinuation = true;
			}
			if (!launchedContinuation) {
				await this._emitAgentSettled(event);
			} else {
				this._abortProvenance.closeAgentEndBoundary();
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

	private _isCircuitProbeOnCurrentModel(): boolean {
		const model = this.model;
		return model !== undefined && this._retryFallback.probes.holds(formatSelector(model));
	}

	/** The first streamed content from the probed entry proves it serves again. */
	private _acceptCircuitProbeOnProgress(message: AssistantMessage, event: AssistantMessageEvent): void {
		const probing = this._retryFallback.probes.probing;
		if (probing === undefined || `${message.provider}/${message.model}` !== probing) return;
		const streamedContent =
			(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
			event.delta.length > 0;
		if (!streamedContent) return;
		this._retryFallback.probes.accept(probing);
		this._clearCircuitProbeWatchdog();
	}

	/**
	 * A probe holds the circuit's only admission until it settles, so it must never
	 * hang: with the stream-start guard disabled, the probe still gets that guard's
	 * default bound and is aborted as a provider failure when it expires.
	 */
	private _armCircuitProbeWatchdog(): void {
		this._clearCircuitProbeWatchdog();
		const probing = this._retryFallback.probes.probing;
		if (probing === undefined || this.agent.streamStartTimeoutMs !== undefined) return;
		const timeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		this._circuitProbeWatchdog = setTimeout(() => {
			this._circuitProbeWatchdog = undefined;
			if (this._retryFallback.probes.probing !== probing) return;
			this.agent.abort(
				new ProviderRetryWatchdogAbortError(`Circuit probe of ${probing} sent no response within ${timeoutMs}ms`),
			);
		}, timeoutMs);
	}

	private _clearCircuitProbeWatchdog(): void {
		if (this._circuitProbeWatchdog === undefined) return;
		clearTimeout(this._circuitProbeWatchdog);
		this._circuitProbeWatchdog = undefined;
	}

	private async _emitSessionAbort(): Promise<void> {
		await this._extensionRunner.emit({ type: "session_abort" });
		this._emit({ type: "session_abort" });
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
				// The shared circuit gates probe-back like any other request: no probe
				// before the provider's Retry-After or the cooldown elapses, and none
				// while another session holds the circuit's single probe.
				const admission = this._fallbackCircuits.admit(selector, `probe-back:${++this._probeBackLaneSeq}`);
				if (admission.kind === "open") return false;
				try {
					const result = await this._modelRuntime.completeSimple(
						demotedModel,
						{
							systemPrompt: "Reply with OK.",
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "OK" }],
									timestamp: now,
								},
							],
						},
						{ maxTokens: 1, signal, cwd: this._cwd },
					);
					const ok = result.stopReason !== "error" && result.stopReason !== "aborted";
					if (!ok && result.stopReason === "error" && admission.kind === "probe") {
						this._fallbackCircuits.noteFailure(selector, { errorMessage: result.errorMessage });
					}
					return ok;
				} catch {
					return false;
				} finally {
					if (admission.kind === "probe") this._fallbackCircuits.release(admission.token);
				}
			},
			onCleared: (sel: string) => {
				this._selectorCooldowns.clear(sel);
				this._fallbackCircuits.close(sel);
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

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
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
		// and the eventual SessionManager.appendOwnedMessage(event.message) persistence in sync.
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
			const extensionEvent = this._abortProvenance.beginAgentEnd(
				event.messages,
				agentEndWillRetry,
				this._findLastAssistantInMessages(event.messages)?.stopReason === "aborted",
			);
			try {
				const guardStartLeafId = this.sessionManager.getLeafId();
				await this._extensionRunner.emit(extensionEvent);
				await this._lifecycleBinding.turnEnded(extensionEvent, event, guardStartLeafId);
			} finally {
				this._abortProvenance.endAgentEnd(extensionEvent);
			}
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
			this._flushPendingCustomMessages();
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
			this._deadlineTracker.renew();
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			this._deadlineTracker.renew();
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			this._deadlineTracker.renew();
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
		if (this._resumeCompactionRequirement !== undefined) {
			listener({
				type: "resume_compaction_required",
				projection: this._resumeCompactionRequirement.projection,
				notice: this._resumeCompactionRequirement.notice,
			});
		}
		if (this._resumeSlice !== undefined) {
			listener(this._resumeSliceEvent(this._resumeSlice));
		}
		if (this._standingRecovery !== undefined) listener(this._standingRecovery);
		for (const source of this.settingsManager.getSelectedSettingsSources()) {
			listener({ type: "settings_source_selected", ...source });
		}

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * The internal structured lane (senpi#4272): every session event in `_emit` order with its provider capture, plus
	 * block controls at their position. Attach before a turn's first provider push; a stream already pushing keeps
	 * its decision and yields no capture.
	 */
	subscribeStructured(
		listener: (record: AgentSessionStructuredRecord) => void,
		failed?: (cause: unknown) => void,
	): () => void {
		return this._structuredLane.subscribe(listener, failed);
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
		this._disposed = true;
		this._unsubscribeSecurityNotices?.();
		this.securityNotices.dispose();
		clearMcpGrantPresentations(this.sessionId);
		this._engineTurnHold.invalidate();
		this._deadlineTracker.disarm();
		this._toolBarrier.clear();
		for (const dispose of this._toolContextDisposers) dispose();
		try {
			this._probeBackScheduler.cancel("dispose");
			this._clearCircuitProbeWatchdog();
			this._retryFallback.probes.releaseAll();
			this._fallbackCircuitsLease.release();
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
		this._releaseToolSearchService("session disposed");
		// In-process offload jobs are closed with the child: replacement awaits both before the next session runs.
		const inProcessClosed = this._toolDispatcher
			.dispose()
			.catch((error: unknown) => this._sessionLogger.warn("tool_dispatcher_close_failed", { error: String(error) }));
		const childClosed =
			this._toolChild
				?.close()
				.catch((error: unknown) => this._sessionLogger.warn("tool_child_close_failed", { error: String(error) })) ??
			Promise.resolve();
		this._toolChildClosed = Promise.all([inProcessClosed, childClosed]).then(() => undefined);
		this._disconnectFromAgent();
		this._unsubscribeSettingsSource?.();
		this._unsubscribeSettingsSource = undefined;
		this._unregisterMemoryReport();
		this._unsubscribeWakeSources?.();
		this._unsubscribeWakeSources = undefined;
		this._lifecycleBinding.dispose();
		this._unsubscribeRecovery?.();
		this._unsubscribeRecovery = undefined;
		this._eventListeners = [];
		this._structuredLane.dispose();
		cleanupSessionResources(this.sessionId);
		// Nothing reads or writes this manager once its session is gone: it releases
		// its writer grant and its disposable blob directory here.
		this.sessionManager.dispose();
	}

	/** Extension-published wake sources that currently report live work, by `source` name. */
	get activeWakeSources(): readonly string[] {
		return this._wakeSources.activeSources;
	}

	/** Live in-session activity signals; see `session-activity.ts` for the contract. */
	get activitySnapshot(): SessionActivitySnapshot {
		return {
			isStreaming: this._isAgentRunActive,
			isBashRunning: this.isBashRunning,
			isCompacting: this.isCompacting,
			hasSessionWork:
				this._sessionWorkBarrier.hasActiveWork || this._promptStartPending || this.externalAdmission.hasInputWork,
			hasActiveWakeSource: this._wakeSources.hasActive,
		};
	}

	/**
	 * Whether this session owns work that must outlive a teardown decision: an
	 * agent run, bash, compaction, barrier-held session work, or an
	 * extension-published wake source. Occupancy sweeps (the shared RPC host's
	 * idle eviction) MUST consult this rather than individual flags, so a new
	 * activity source is picked up by every call site at once.
	 */
	get isSessionBusy(): boolean {
		return isSessionBusySnapshot(this.activitySnapshot);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

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

	/** Explicit selector provenance, absent for SDK-defaulted effective levels. */
	get thinkingSelection(): ThinkingSelection | undefined {
		return this.agent.state.thinkingSelection;
	}

	/** Where the thinking level in force came from (senpi#3819). */
	get thinkingLevelSource(): ThinkingLevelSource {
		return this._thinkingLevelSource;
	}

	/** This session's last thinking level per model, keyed `provider/id` (senpi#3819). */
	getSessionModelThinkingLevels(): Record<string, ThinkingLevel> {
		return this._sessionThinkingMemory.levels();
	}

	/**
	 * The level `model` runs at in this session: the current one for the active model, otherwise the
	 * level a switch to it would restore. Nothing is applied (senpi#3819).
	 */
	getThinkingLevelForModel(model: Model<Api>): {
		level: ThinkingLevel;
		source: ThinkingLevelSource;
		availableLevels: ThinkingLevel[];
	} {
		const availableLevels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		if (this.model && modelsAreEqual(this.model, model)) {
			return { level: this.thinkingLevel, source: this._thinkingLevelSource, availableLevels };
		}
		const { level, source } = this._getThinkingForModelSwitch(model);
		return { level, source, availableLevels };
	}

	/** An explicit thinking request clamped while this session was created (senpi#2395). */
	get startupThinkingClamp(): ThinkingClampNotice | undefined {
		return this._startupThinkingClamp;
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
		// An explicit Ultrafast tier outranks stale Priority-mode state.
		return (
			this._currentServiceTier !== "ultrafast" && (this._sessionFastMode || this._currentServiceTier === "priority")
		);
	}

	/**
	 * The tier a request would carry right now: `serviceTier`, promoted to `"priority"` while
	 * session fast mode is on (which is exactly what the service-tier extension puts on the
	 * wire). Reported to clients so `serviceTier` and `fastMode` can never disagree.
	 */
	get effectiveServiceTier(): ServiceTier | undefined {
		return this.isFastModeActive() ? "priority" : this._currentServiceTier;
	}

	/**
	 * Session-scoped fast-mode indicator; never persisted, reset on session start.
	 *
	 * Turning fast OFF also clears the cached priority tier: `/fast off` writes a remembered
	 * `"auto"` that must override an inherited catalog-priority tier immediately (display and
	 * request side), not only on the next session. Only codex-response models are touched, and
	 * never when an explicit scoped/favorite `:priority` pin is in force — those are pinned by
	 * the user's model selection, not by `/fast`.
	 */
	setSessionFastMode(enabled: boolean): void {
		const previousFastMode = this.isFastModeActive();
		const previousTier = this._currentServiceTier;
		this._sessionFastMode = enabled;
		if (!enabled && this._currentServiceTier === "priority" && this.model?.api === CODEX_RESPONSES_API) {
			// Only an INHERITED (catalog) priority is cleared. A priority the catalog does not
			// explain came from an explicit scoped/favorite `:priority` pin, which `/fast` must not undo.
			if (this._modelRuntime.getCompatibilityRequestConfig(this.model).serviceTier === "priority") {
				this._currentServiceTier = undefined;
			}
		}
		this._emitServiceTierChangeIfNeeded(previousTier, previousFastMode);
	}

	/**
	 * Emit `service_tier_changed` when the effective tier or the fast-mode indicator actually
	 * moved. Both are observable state for RPC clients (`get_state.serviceTier` / `.fastMode`),
	 * and they can move independently: a session fast-mode toggle need not change the resolved
	 * tier, and a model switch can change the tier with fast mode untouched.
	 */
	private _emitServiceTierChangeIfNeeded(previousTier: ServiceTier | undefined, previousFastMode: boolean): void {
		const fastMode = this.isFastModeActive();
		if (previousTier === this._currentServiceTier && previousFastMode === fastMode) return;
		this._emit({
			type: "service_tier_changed",
			tier: this.effectiveServiceTier,
			fastMode,
		});
	}

	/**
	 * Explicit scoped/favorite tiers win; otherwise fall back to the model's
	 * configured serviceTier from models.json/extension compatibility config. The per-model
	 * `/fast` memory is honored by the service-tier extension (`liveMemoryTier` + the session
	 * flag in `before_provider_request`), not cached here: caching it would survive a same-session
	 * `/fast off` (no model switch to re-resolve) and leak an inherited priority onto the wire.
	 */
	private _resolveServiceTier(
		model: Model<any> | undefined,
		explicit: ServiceTier | undefined,
	): ServiceTier | undefined {
		if (explicit) return explicit;
		if (!model) return undefined;
		return this._modelRuntime.getCompatibilityRequestConfig(model).serviceTier;
	}

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** True while a provider retry is in flight; the deadline lease treats it as turn progress. */
	get isRetryInFlight(): boolean {
		return this._retryPromise !== undefined;
	}

	/** Whether the session has no active agent run, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/**
	 * Rebuilds the prompt for another surface (a later `open_session.promptSurface`). The next
	 * turn's `before_agent_start` hands presets the new surface through `systemPromptOptions`.
	 */
	setPromptSurface(surface: PromptSurface): void {
		const current = this._baseSystemPromptOptions.surface;
		this._promptSurface = surface;
		if (current === surface) return;
		this._systemPromptOverride = undefined;
		this._applyToolDeclarations(this.getActiveToolNames());
	}

	/** Moves this session to another browser engine (a later `open_session.browserEngine`); the next tool call sees it. */
	setBrowserEngine(engine: BrowserEngine): void {
		this._browserEngine = engine;
	}

	get browserEngine(): BrowserEngine | undefined {
		return this._browserEngine;
	}

	get sessionEnv(): Readonly<Record<string, string>> | undefined {
		return this._sessionEnv;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/** Abort owner for the current turn boundary, used by internal renderers. */
	get currentAbortSource(): AgentAbortSource | undefined {
		return this._abortProvenance.currentSource;
	}

	/** The deadline that stopped the current turn, when the lease fired (senpi#3227). */
	get currentDeadline(): TurnDeadline | undefined {
		return this._deadlineTracker.current;
	}

	/** Adapter for the deadline owner interface: a deadline stop that could not complete. */
	_warnDeadline(event: TurnDeadlineWarning, detail: string): void {
		this._sessionLogger.warn(event, { detail });
	}

	/** Adapter for the deadline owner interface: end the turn through the normal system abort. */
	async abortTurnForDeadline(): Promise<void> {
		await this._abortActiveAgentAndRetry("system");
		// An abort that joined an open agent_end boundary returns at once; the run is still held until it settles.
		if (!this.isIdle) await this._waitForIdleAfterAbort();
	}

	/**
	 * An abort (Esc, or the turn deadline) that the run does not honour within the grace is held by an extension handler
	 * no abort signal reaches: release the turn's held handler waits so it settles (senpi#3650).
	 */
	private async _waitForIdleAfterAbort(): Promise<void> {
		const idle = this.waitForIdle();
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const graceOver = new Promise<true>((resolve) => {
			graceTimer = setTimeout(() => resolve(true), TURN_DEADLINE_GRACE_MS);
		});
		const stillHeld = await Promise.race([idle.then(() => false), graceOver]);
		clearTimeout(graceTimer);
		if (stillHeld) this._extensionRunner.releaseHeldHandlers(this._handlerTurnScope);
		await idle;
	}

	/** Adapter for the deadline owner interface: stop waiting on extension handlers that hold the turn (senpi#3650). */
	releaseHeldExtensionHandlers(): number {
		return this._extensionRunner.releaseHeldHandlers(this._handlerTurnScope);
	}

	/** Record a deadline stop durably so the goal engine holds off until admitted user input. */
	_recordDeadlineStop(deadline: TurnDeadline): void {
		const at = Date.now();
		// The lifecycle stop is captured before the write, so a refused write keeps it for this run (senpi#3864).
		this._lifecycleBinding.deadlineStopped(deadline.kind, at);
		let entryId: string;
		try {
			entryId = this.sessionManager.appendCustomEntry(TURN_DEADLINE_ENTRY_TYPE, {
				kind: deadline.kind,
				limitMs: deadline.limitMs,
				elapsedMs: deadline.elapsedMs,
				at,
			});
		} catch (error) {
			this._lifecycleBinding.deadlineStopWriteFailed();
			throw error;
		}
		this._emitEntryAppended(entryId);
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent. Tools with `search` or `eval` exposure
	 * are callable from other tools through `ctx.executeTool()` without being active.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * Get all configured tools with normalized exposure metadata and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			label: definition.label,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			kernelPrelude: projectKernelPrelude(definition.name, definition.kernelPrelude),
			permissionParser: definition.permissionParser,
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			sourceInfo,
			...normalizeToolExposure(definition),
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * The tool a call named `requested` runs, by the same rule the agent loop
	 * applies (exact name, else the unique alias among callable tools), without
	 * activating anything. Returns `requested` when nothing resolves.
	 */
	resolveToolCallName(requested: string): string {
		return resolveToolNameAlias(requested, this._callableToolNames()) ?? requested;
	}

	/**
	 * Serves the tool child's `completion` or `reserved` calls on the server (codemode registers its completion handler and
	 * `runReservedTool`, which hold `evalHandleHost`). Returns the unregister function; a later registration replaces it.
	 */
	registerToolChildHostTarget(kind: RegisteredHostCallKind, target: HostCallTarget): () => void {
		this._toolChildHostTargets.set(kind, target);
		return () => {
			if (this._toolChildHostTargets.get(kind) === target) this._toolChildHostTargets.delete(kind);
		};
	}

	async executeTool<TDetails = unknown>(
		toolName: string,
		params: unknown,
		options?: ExecuteToolOptions<TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		let activeTools = this.getActiveToolNames();
		let tool = this.agent.state.tools.find((candidate) => candidate.name === toolName);
		if (!tool && this._isEvalOnlyPolicyArmed() && this._evalOnlyToolNames?.has(toolName)) {
			tool = this._toolRegistry.get(toolName);
		}
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
			// Tool calls carry JSON arguments (C-AI-4); extension params arrive as parsed JSON.
			arguments: params as JsonObject,
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

		const beforeResult = await this.preflightToolCall(prepared.toolCall, prepared.args, {
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
			isError = result.isError === true;
		} catch (err) {
			result = {
				content: [
					{
						type: "text",
						text: err instanceof Error ? err.message : String(err),
					},
				],
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

	/**
	 * Lazily activate a registered inactive tool.
	 *
	 * Resolution order is deliberate: resolve the winning definition and enforce its
	 * `allowLazyActivation` hard stop, then invoke activators in registration order.
	 * The caller re-resolves the tool from the active registry before execution.
	 */
	/** The child jobs the registered tools declare (`ToolDefinition.childJob`): who a child's wake or exit concerns. */
	private _childJobs(): ToolChildJob[] {
		return this._extensionRunner
			.getAllRegisteredTools()
			.flatMap((tool) => (tool.definition.childJob === undefined ? [] : [tool.definition.childJob]));
	}

	private _callableToolNames(): string[] {
		const names = this.agent.state.tools.map((tool) => tool.name);
		for (const [name, { definition }] of this._toolDefinitions) {
			const exposure = normalizeToolExposure(definition);
			if (exposure.exposure === "search" && exposure.allowLazyActivation) names.push(name);
		}
		return [...names, ...this._toolSearchCatalogNames()];
	}

	private _toolSearchCatalogNames(): string[] {
		return this._toolSearchService?.getCatalog().map((doc) => doc.name) ?? [];
	}

	private _activateLazyTool(toolName: string): boolean {
		return this._lazyToolActivation.activate(toolName);
	}

	private _isEvalOnlyPolicyArmed(): boolean {
		return this._evalOnlyToolNames !== undefined && this._toolRegistry.has("eval");
	}

	/** Resolve fixed and declared eval-only tools, unless an SDK embedder supplied an override. */
	private _resolveEvalOnlyToolNames(): ReadonlySet<string> {
		const declaredEvalNames = [...this._toolDefinitions.values()]
			.filter(({ definition }) => normalizeToolExposure(definition).exposure === "eval")
			.map(({ definition }) => definition.name);
		return this._evalOnlyToolNamesOverride ?? new Set([...EVAL_ONLY_TOOL_NAMES, ...declaredEvalNames]);
	}

	/**
	 * Publish per-tool eval-only redirect hints so a direct call names its own eval helper.
	 *
	 * Hints published here are tracked so a disarm - or a shrinking armed set, e.g. bash+workflow
	 * down to workflow only - withdraws the stale ones. Only tracked names are ever deleted, so
	 * hints owned by other publishers survive.
	 */
	private _publishEvalOnlyToolHints(): void {
		const armed = this._isEvalOnlyPolicyArmed() ? (this._evalOnlyToolNames ?? new Set<string>()) : undefined;
		const registered = armed ? new Set([...armed].filter((name) => this._toolRegistry.has(name))) : undefined;
		for (const name of this._publishedEvalOnlyHintNames) {
			if (registered?.has(name)) continue;
			delete this.agent.removedToolHints[name];
		}
		this._publishedEvalOnlyHintNames.clear();
		if (!registered) return;
		for (const name of registered) {
			this.agent.removedToolHints[name] =
				`Run ${name} inside an eval cell via ${evalHelperCall(name)}; hooks and permissions still apply.`;
			this._publishedEvalOnlyHintNames.add(name);
		}
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	/**
	 * Resolve an executable tool from the full registry (builtin + extension
	 * tools), independent of the active set. The Cursor exec bridge uses this:
	 * Cursor drives its native tools (read/bash/grep/ls/write) over the exec
	 * channel regardless of which tools the request advertised.
	 */
	getRegisteredTool(name: string): AgentTool | undefined {
		return this._toolRegistry.get(name);
	}

	/** Cursor exec already ran the tool; still emit tool_result so plan-touch trackers see .omo/plans writes. */
	async emitExecBridgeToolResult(
		toolName: string,
		toolCallId: string,
		args: unknown,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<void> {
		await this._emitAfterToolCallHooks(
			{
				type: "toolCall",
				id: toolCallId,
				name: toolName,
				arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as JsonObject) : {},
			},
			args,
			result,
			isError,
		);
	}

	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const policyArmed = this._isEvalOnlyPolicyArmed();
		this._publishEvalOnlyToolHints();
		const policyNames = this._evalOnlyToolNames;
		let filteredToolNames = toolNames;
		if (policyArmed && policyNames) {
			for (const name of toolNames) {
				if (policyNames.has(name)) this._withheldEvalOnlyToolNames.add(name);
			}
			filteredToolNames = toolNames.filter((name) => !policyNames.has(name));
		} else {
			this._withheldEvalOnlyToolNames.clear();
		}
		// Remember the unfiltered request so a later disarm can restore withheld eval-only tools.
		this._requestedActiveToolNames = [...new Set([...toolNames, ...this._withheldEvalOnlyToolNames])];
		for (const name of filteredToolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool && this._getToolExposure(name) !== "hidden") {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		const activeToolNamesChanged =
			validToolNames.length !== this.agent.state.tools.length ||
			validToolNames.some((name, index) => name !== this.agent.state.tools[index]?.name);
		const previousToolNames = new Set(this.agent.state.tools.map((tool) => tool.name));
		this.agent.state.tools = tools;
		for (const name of validToolNames) {
			if (!this._declaredToolNames.includes(name)) this._declaredToolNames.push(name);
		}

		// Rebuild base system prompt with new tool set
		this._applyToolDeclarations(validToolNames);
		if (activeToolNamesChanged) {
			// A tool change emitted while extensions are still binding belongs to the
			// binding itself, not to a mid-session change. The session was already
			// committed to the client, so cancelling or invalidating work it started
			// against that session would be spurious.
			if (this._extensionBindingPromptReadiness === undefined) {
				this.abortCompaction();
				this._incrementMessageRevision();
			}
		}
		// senpi#2128: notification-only; the runner reports handler failures, so nothing awaits it.
		const activatedToolNames = validToolNames.filter((name) => !previousToolNames.has(name));
		if (activatedToolNames.length > 0 && this._extensionRunner?.hasHandlers("tool_activated")) {
			void this._extensionRunner.emit({ type: "tool_activated", toolNames: activatedToolNames });
		}
	}

	/**
	 * senpi#2095: a model that accepts `allowed_tools` is declared every tool this session has
	 * activated, and the prompt's tool section lists that same set, so the active set shrinking or
	 * re-growing restricts callability through `tool_choice` instead of rewriting the cached prefix.
	 * Any other model is declared exactly the active tools.
	 */
	private _declaresSessionTools(): boolean {
		const model = this.model;
		return model !== undefined && supportsAllowedToolChoice(model);
	}

	private _toolDeclarationNames(activeToolNames: readonly string[]): string[] {
		if (!this._declaresSessionTools()) return [...activeToolNames];
		return this._declaredToolNames.filter((name) => this._toolRegistry.has(name));
	}

	private _applyToolDeclarations(activeToolNames: readonly string[]): void {
		this._promptDeclaresSessionTools = this._declaresSessionTools();
		const declaredNames = this._toolDeclarationNames(activeToolNames);
		const declaresInactiveTools =
			declaredNames.length !== activeToolNames.length ||
			declaredNames.some((name, index) => name !== activeToolNames[index]);
		this.agent.state.declaredTools = declaresInactiveTools
			? declaredNames.flatMap((name) => this._toolRegistry.get(name) ?? [])
			: undefined;
		this._baseSystemPrompt = this._rebuildSystemPrompt(declaredNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/**
	 * Re-derive the declaration after a model change. Only a switch into or out of a model that declares
	 * the session set can move it, and the prompt is rebuilt only when its tool list actually moves.
	 */
	private _refreshToolDeclarationsForModel(): void {
		if (!this._declaresSessionTools() && !this._promptDeclaresSessionTools) return;
		const declaredNames = this._toolDeclarationNames(this.getActiveToolNames());
		const unchanged =
			declaredNames.length === this._promptToolNames.length &&
			declaredNames.every((name, index) => name === this._promptToolNames[index]);
		if (!unchanged) this._applyToolDeclarations(this.getActiveToolNames());
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
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
		return this._runtimeMessages();
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

	/** Subscribe to the internal event bus shared by this session's extensions. */
	onExtensionEvent(channel: string, handler: (data: unknown) => void): () => void {
		return this._resourceLoader.onExtensionEvent?.(channel, handler) ?? (() => {});
	}

	/** Host input entry point; not exposed by the extension API or its event bus. */
	recordUserActivity(kind: UserActivityKind): void {
		this._userActivity.emit(kind);
	}

	/** Publish on the internal event bus shared by this session's extensions. */
	emitExtensionEvent(channel: string, data: unknown): void {
		this._resourceLoader.emitExtensionEvent?.(channel, data);
	}

	/** Installed by the interactive mode before it binds extensions; `pi.session.registerControlEndpoint` needs one. */
	setControlEndpointHost(host: ControlEndpointHost | undefined): void {
		this._controlEndpointHost = host;
	}

	/** Installed by a host that can continue this session on another computer (`pi.session.requestRelocation`). */
	setRelocationHost(host: SessionRelocationHost | undefined): void {
		this._relocationHost = host;
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Globally narrowed models (from --models / enabledModels) */
	get scopedModels(): ReadonlyArray<SessionModelEntry> {
		return this._scopedModels;
	}

	/** Update global model narrowing */
	setScopedModels(scopedModels: SessionModelEntry[]): void {
		this._scopedModels = scopedModels;
	}

	/** Favorite models for Ctrl+P cycling */
	get favoriteModels(): ReadonlyArray<SessionModelEntry> {
		return this._getCurrentFavoriteModels();
	}

	/** Update favorite models for Ctrl+P cycling */
	setFavoriteModels(favoriteModels: SessionModelEntry[]): void {
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
				thinkingSelection: favorite.thinkingSelection,
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
		this._promptToolNames = validToolNames;
		// An eval-only tool is hidden from the model but still callable as `tool.<name>(...)`,
		// so its own snippet and guidelines still apply and must survive the withholding.
		// `selectedTools` stays the model-visible list; only the contributions are widened.
		// This can run before the field initializers below it during construction, so the
		// withheld set is read defensively rather than spread directly.
		const withheld = this._withheldEvalOnlyToolNames ?? new Set<string>();
		const contributingToolNames = [
			...validToolNames,
			...[...withheld].filter((name) => this._toolRegistry.has(name) && !validToolNames.includes(name)),
		];
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of contributingToolNames) {
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
			surface: this._promptSurface ?? resolvePromptSurface(process.env),
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt: loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined,
		};
		const prompt = buildDynamicSystemPrompt({
			...this._baseSystemPromptOptions,
			onParts: (parts) => {
				this._baseSystemPromptParts = parts;
			},
		});
		if (!this._isEvalOnlyPolicyArmed()) return prompt;
		const armed = this._evalOnlyToolNames ?? new Set<string>();
		const registered = new Set([...armed].filter((name) => this._toolRegistry.has(name)));
		const sentences: string[] = [];
		const shellHelpers = ["bash", "powershell"].filter((name) => registered.has(name)).map(evalHelperCall);
		if (shellHelpers.length > 0) {
			sentences.push(
				`Shell commands run ONLY inside eval cells via ${shellHelpers.join(" or ")}; hooks and permissions still apply.`,
			);
		}
		if (registered.has("workflow")) {
			sentences.push(
				`The workflow tool runs ONLY inside eval cells via ${evalHelperCall("workflow")}; hooks and permissions still apply.`,
			);
		}
		// Declared tools and SDK overrides outside the built-in groups still need eval guidance.
		const otherHelpers = [...registered]
			.filter(
				(name) =>
					name !== "bash" && name !== "powershell" && name !== "workflow" && name !== "grep" && name !== "glob",
			)
			.map(evalHelperCall);
		if (otherHelpers.length > 0) {
			sentences.push(
				`These tools run ONLY inside eval cells via ${otherHelpers.join(" or ")}; hooks and permissions still apply.`,
			);
		}
		if (registered.has("glob")) {
			sentences.push(
				`File-name search runs ONLY inside eval cells via ${evalHelperCall("glob")}; it matches a glob such as **/*.ts, respects .gitignore, and applies hooks and permissions - prefer it over find/ls in tool.bash.`,
			);
		}
		if (registered.has("grep")) {
			sentences.push(
				`Text search runs ONLY inside eval cells via ${evalHelperCall("grep")}; it returns structured matches, respects .gitignore, and applies hooks and permissions - prefer it over rg/grep in tool.bash.`,
			);
		}
		return sentences.length > 0 ? `${prompt}\n\n${sentences.join("\n\n")}` : prompt;
	}

	/**
	 * Run `input` extension handlers for queued (steer / follow-up) input.
	 *
	 * Queued input reaches the model exactly like a prompt does, so it passes the same
	 * extension surface: a handler may consume it or rewrite it. The input keeps the
	 * session-scoped `inputId` identity, so the `input_disposition` event a handler
	 * observes correlates with the input it saw.
	 *
	 * @returns the (possibly transformed) input, or `undefined` when a handler consumed it.
	 */
	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		attribution: InputAttribution,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined; inputId?: string } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputId = `${this.sessionManager.getSessionId()}:${++this._nextInputId}`;
		const inputResult = await this._extensionRunner.emitInput(
			text,
			images,
			source,
			streamingBehavior,
			inputId,
			attribution,
		);
		if (inputResult.action === "handled") {
			await this._emitInputDisposition(inputId, "handled");
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images, inputId };
		}
		return { text, images, inputId };
	}

	private async _emitInputDisposition(
		inputId: string | undefined,
		disposition: "handled" | "queued" | "started" | "rejected",
	): Promise<void> {
		if (inputId === undefined) return;
		await this._extensionRunner.emit({ type: "input_disposition", inputId, disposition });
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
		this._standingRecovery = undefined;
		const barrierError = options?.toolBarrier === undefined ? undefined : toolBarrierSpecError(options.toolBarrier);
		if (barrierError !== undefined) throw new Error(barrierError);
		if (isHumanInput(options) && options?.humanInputReported !== true) this._humanInputAdmitted(promptKind(options));
		// Held synchronously, before any await: an external delivery never overtakes this input.
		const hold = this.externalAdmission.beginInput({
			command: this._isExtensionCommandText(text, options),
			submittedByCommand: options?.source === "extension",
		});
		this._promptsInFlight++;
		const observedPauseSeq = this._engineTurnHold.currentPauseSeq;
		let heldByNewerStop = false;
		try {
			const origin = options?.inputOrigin ?? inputOriginOf(options?.source);
			if (origin === "person" && this._runHolds.inheritedOwner() !== undefined) {
				// A run-owned pause holds every person input before anything runs, a "." or a command included (senpi#3811).
				this._holdForRun(text, options);
				hold.accepted();
				options?.promptDisposition?.("handled");
				options?.preflightResult?.(true);
				return;
			}
			if (origin === "person") {
				this._beginPersonInput();
				// The held commands this input released run first, in the order typed, so its turn starts after them.
				const heldCommands = this._takeHeldCommandRun();
				if (heldCommands !== undefined) await heldCommands;
			}
			await this._prompt(text, {
				...options,
				observedPauseSeq,
				onHeldByNewerStop: () => {
					heldByNewerStop = true;
				},
				promptDisposition: (disposition) => {
					if (disposition !== "started") hold.accepted();
					if (!heldByNewerStop && (disposition === "started" || disposition === "queued"))
						this._engineTurnInput.admit(disposition === "queued", (message) => this.agent.steer(message));
					options?.promptDisposition?.(disposition);
				},
				onTurnAdmitted: () => {
					hold.accepted();
					options?.onTurnAdmitted?.();
				},
			});
			if (heldByNewerStop) {
				// A Stop landed after this input was accepted: it became held input and the released holds come back.
				this._deliveredHeldInputIds.length = 0;
				this._engineTurnInput.reject();
			}
		} finally {
			this._promptsInFlight--;
			// No await unless a release is pending: settling must not delay a prompt's completion.
			const settling = this._settleInputRelease();
			if (settling) {
				try {
					await settling;
				} finally {
					hold.end();
				}
			} else hold.end();
		}
	}

	/** A person's input (prompt, steer, follow-up, answer) attends the session and releases what it holds. */
	private _beginPersonInput(): void {
		emitUserActivity(this, "prompt");
		this._deadlineTracker.clearHold();
		this._engineResumeWindow = false;
		this._captureReleaseExtras();
		this._engineTurnInput.begin({ consumeAtSettlement: this._stopHoldLive() });
	}

	/**
	 * Every input release settles here, once nothing could still admit it: no prompt in flight (a
	 * command's follow-on reaches `prompt()` synchronously) and no run active. Called from every
	 * prompt's `finally`, from run settlement, and after an answer is dispatched.
	 */
	private _settleInputRelease(): Promise<void> | undefined {
		if (!this._engineTurnInput.hasPending) return undefined;
		if (this._promptsInFlight > 0 || this._isAgentRunActive || !this.isIdle) return undefined;
		// Turns deferred by the agent_settled window or the session_start gate still enter prompt() later.
		if (this._agentSettledDelivery.active || this._extensionRunner.sessionStartTurnsHeld()) return undefined;
		// Held human input counts as delivered only if no newer Stop aborted the turn that carried it (senpi#3811).
		const newerStop = this._releaseExtrasGeneration !== this._userAbortGeneration;
		if (newerStop) this._deliveredHeldInputIds.length = 0;
		return this._engineTurnInput.settle(
			async (sources) => {
				this._heldInputs.consume(this._deliveredHeldInputIds.splice(0));
				await this._extensionRunner.emitHeldWakesReleased(sources);
			},
			{ newerStop },
		);
	}

	/**
	 * Hold a person's raw input for the parent's run Resume under its client id, so a replay is held once; its
	 * commands, skills and templates run when it is delivered. The child's own Stop goes only once the input is held.
	 */
	private _holdForRun(text: string, options: PromptOptions | undefined): void {
		if (options?.signal?.aborted) {
			const error = new Error("Prompt cancelled before acceptance");
			error.name = "AbortError";
			throw error;
		}
		emitUserActivity(this, "prompt");
		const images = options?.images;
		const held = this._heldInputs.hold({
			inputId: options?.clientMessageId ?? `prompt-${crypto.randomUUID()}`,
			revision: 0,
			text,
			...(images === undefined || images.length === 0 ? {} : { images }),
			...((options?.expandPromptTemplates ?? true) ? { prepare: true as const } : {}),
		});
		if (held.kind === "held") this._runHolds.releaseDirectStops();
	}

	/** Hold a person's prepared input (expanded text and images) under its client id, so a replay is held once. */
	private _holdPreparedInput(text: string, images: ImageContent[] | undefined, options: PromptOptions): void {
		this._heldInputs.hold({
			inputId: options.clientMessageId ?? `prompt-${crypto.randomUUID()}`,
			revision: 0,
			text,
			...(images === undefined || images.length === 0 ? {} : { images }),
		});
	}

	private _isExtensionCommandText(text: string, options?: PromptOptions): boolean {
		if (!(options?.expandPromptTemplates ?? true) || !text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		return (
			this._extensionRunner.getCommand(spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)) !== undefined
		);
	}

	private async _prompt(text: string, options: PromptOptions): Promise<void> {
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

		// Extension commands are UI actions, not prompts: dispatch them before the
		// settled-session-work gate below. That gate makes a bare prompt() wait for
		// _sessionWorkBarrier, which a scheduled continuation (goal chain, queued
		// follow-up) holds for an entire run, so a command typed mid-turn used to run
		// only after the turn ended. The registry lookup stays synchronous so ordinary
		// text beginning with "/" gains no await before the prompt-start bookkeeping.
		try {
			if ((options?.expandPromptTemplates ?? true) && text.startsWith("/")) {
				const spaceIndex = text.indexOf(" ");
				const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
				if (this._extensionRunner.getCommand(commandName)) {
					const handled = await this._tryExecuteExtensionCommand(text);
					throwIfCancelled();
					if (handled) {
						options?.promptDisposition?.("handled");
						options?.preflightResult?.(true);
						return;
					}
				}
			}
		} catch (error) {
			options?.preflightResult?.(false);
			throw error;
		}

		if (options?.source !== "extension" && this._compactionAbortController !== undefined) {
			options?.preflightResult?.(false);
			throw new Error(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		}

		// An idle submission claims the start even when it carries a streamingBehavior, so input arriving
		// while it is still starting (another `whenIdle: "start"`, a queued-or-start prompt) joins this turn
		// instead of starting a second one. Queue decisions below read the claim state from before this call.
		// The claim this input joins, if it joins one; checked (synchronously) again before the input queues.
		const joinedClaim = this._promptStartPending && !this.isStreaming ? this._promptStartClaim : undefined;
		let startWasPending = this._promptStartPending;
		let ownsPromptStart = false;
		let claim: { started?: boolean; joined?: boolean } | undefined;
		const claimStart = (): void => {
			ownsPromptStart = true;
			claim = {};
			this._promptStartPending = true;
			this._promptStartClaim = claim;
		};
		if (!this.isStreaming && !startWasPending) claimStart();
		// Releasing a claim that never started its turn runs the input that joined it, and only that: input
		// queued on an idle session by default (`whenIdle: "queue"`) still waits for the next turn.
		const releaseStart = (started: boolean): void => {
			if (!ownsPromptStart || claim === undefined) return;
			claim.started = started;
			this._promptStartPending = false;
			this._notifyAdmissionIdle();
			if (!started && claim.joined === true && !this.isStreaming) {
				// Input that joined while the exemption was armed was parked; the turn it was meant for never ran,
				// so hand it to the drain. The exemption stays armed for the drained run's first response (#4036).
				this._flushPostCompactionDeferredMessages();
				this._drainJoinedInput();
			}
		};
		// A joiner marks the claim it queued into; one that queues after that claim already failed (it awaited in
		// between) drains its own input, since the claimer has nothing left to release.
		const noteJoined = (): void => {
			if (ownsPromptStart || joinedClaim === undefined) return;
			if (joinedClaim.started === false) {
				if (!this.isStreaming) this._drainJoinedInput();
			} else joinedClaim.joined = true;
		};
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
		// A joiner whose claimer already ended without starting (rejected, or handled by an extension or command)
		// takes the start over instead of queueing onto an idle session.
		if (joinedClaim?.started === false && !this.isStreaming) {
			startWasPending = this._promptStartPending;
			if (!startWasPending) claimStart();
		}
		const canQueueWhileStreaming =
			(this.isStreaming || startWasPending) && !this.isCompacting && options?.streamingBehavior !== undefined;
		// Auto-compaction claims only _autoCompactionAbortController, which the
		// admission guard above deliberately ignores so background compaction never
		// rejects typed input. Without a queue route that message matched no branch
		// below and fell through neither queued nor started (field bug: input typed
		// while the TUI showed "Compacting context..." was accepted and dropped).
		// Manual compaction keeps its fail-closed admission path untouched.
		const canQueueDuringAutoCompaction =
			this._autoCompactionAbortController !== undefined &&
			this._compactionAbortController === undefined &&
			!this.isStreaming &&
			!startWasPending &&
			options?.streamingBehavior !== undefined;
		if (
			shouldWaitForSessionWork &&
			!canQueueWhileStreaming &&
			!canQueueDuringAutoCompaction &&
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
				const model = this.model;
				if (model && !this._pendingModelSwitch && this._retryFallback.isProviderSpent(model.provider)) {
					this._retryFallback.resetTurn();
					const errorMessage = this._retryFallback.accountError(model.provider);
					// Routing around a remembered failure did not observe another provider failure.
					if (!(await this._retryFallback.tryFallback("transient", { errorMessage }, false))) {
						throw new AccountUsageLimitError(model.provider, errorMessage);
					}
				}
			} catch (error) {
				releaseStart(false);
				throw error;
			}
		}

		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		const promptDisposition = options?.promptDisposition;
		let messages: AgentMessage[] | undefined;
		let titlePrompt: string | undefined;
		let consumedNextTurnMessages: CustomMessage[] | undefined;
		let consumedReleaseExtras: (CustomMessage | Promise<CustomMessage>)[] | undefined;
		let inputId: string | undefined;
		let pendingCommandInvocation: CommandInvocation | undefined;
		const emitPendingCommandInvocation = (): void => {
			if (!pendingCommandInvocation) return;
			this._emit({
				type: "command_invocation",
				command: pendingCommandInvocation,
			});
			pendingCommandInvocation = undefined;
		};
		const emitInputDisposition = async (
			disposition: "handled" | "queued" | "started" | "rejected",
		): Promise<void> => {
			if (inputId === undefined) return;
			await this._extensionRunner.emit({
				type: "input_disposition",
				inputId,
				disposition,
			});
		};

		try {
			// Bare "." on a session that already has messages is the manual-continue
			// shortcut: it never becomes a visible user turn. Route it through the
			// hidden custom-message path before extensions see an input event, so a
			// "." cannot be echoed, transformed, or persisted as literal text. An
			// empty session, or a "." carrying image attachments (the user is sending
			// the images, not asking to continue), falls through to ordinary prompt
			// handling below.
			if (
				isManualContinueSubmission({
					text,
					hasMessages: this.agent.state.messages.length > 0,
					hasImages: (options?.images?.length ?? 0) > 0,
				})
			) {
				// Report acceptance once the runtime took the continuation - its turn started (as
				// subscribers see it: after that turn's agent_start) or it was queued into a running
				// turn - like an ordinary prompt, not after the whole continued turn.
				let accepted = false;
				const reportAccepted = (): void => {
					if (accepted) return;
					accepted = true;
					promptDisposition?.("handled");
					preflightResult?.(true);
				};
				let turnStarted = false;
				const turnClaim = new DeferredTurnClaim();
				void turnClaim.disposition.then((disposition) => {
					if (disposition === "delegated") reportAccepted();
					else if (disposition === "started") turnStarted = true;
				});
				const unsubscribe = this.subscribe((event) => {
					if (event.type === "agent_start" && turnStarted) reportAccepted();
				});
				try {
					await this.sendCustomMessage(
						{
							customType: MANUAL_CONTINUE_CUSTOM_TYPE,
							content: MANUAL_CONTINUE_DIRECTIVE,
							display: false,
						},
						{
							triggerTurn: true,
							deliverAs: options?.streamingBehavior === "followUp" ? "followUp" : "steer",
						},
						turnClaim,
					);
				} finally {
					unsubscribe();
				}
				reportAccepted();
				return;
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
					attributionOf(options),
				);
				throwIfCancelled();
				if (inputResult.action === "handled") {
					await emitInputDisposition("handled");
					promptDisposition?.("handled");
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform" && !keepsTextBlocksVerbatim(options?.textBlocks)) {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				const skillExpansion = this._expandSkillCommand(expandedText);
				expandedText = typeof skillExpansion === "string" ? skillExpansion : await skillExpansion;
				const templateExpansion = expandPromptTemplateWithMetadata(expandedText, [...this.promptTemplates]);
				expandedText = templateExpansion.text;
				if (
					expandedText === currentText &&
					options?.source !== "extension" &&
					options?.unknownCommandAsText !== true &&
					!/^\s/.test(text)
				) {
					this._rejectUnknownCommand(currentText);
				}
				if (templateExpansion.template) {
					pendingCommandInvocation = {
						name: templateExpansion.template.name,
						source: "prompt",
						sourceInfo: templateExpansion.template.sourceInfo,
						syntax: "slash",
					};
				}
			}
			titlePrompt = options?.sessionTitlePrompt === false ? undefined : (options?.sessionTitlePrompt ?? text);

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new AgentBusyError(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.thinkingLevel !== undefined) {
					throw new Error("Cannot set thinkingLevel on a queued prompt; set it after the current turn completes.");
				}
				// Queued, not started: release the start claim before enqueueing, or a claimed start diverts it.
				releaseStart(false);
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, { ...options, inputId });
				} else {
					await this._queueSteer(expandedText, currentImages, { ...options, inputId });
				}
				noteJoined();
				emitPendingCommandInvocation();
				await this._queuedInputDispositions.queued(inputId);
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
				// Queued, not started: release the start claim before enqueueing, or a claimed start diverts it.
				releaseStart(false);
				if (options?.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, { ...options, inputId });
				} else {
					await this._queueSteer(expandedText, currentImages, { ...options, inputId });
				}
				noteJoined();
				emitPendingCommandInvocation();
				await this._queuedInputDispositions.queued(inputId);
				promptDisposition?.("queued");
				preflightResult?.(true);
				return;
			}

			// Auto-compaction owns the session without claiming the admission controller,
			// so a queueable submission reaches here with no branch above matching and
			// would fall through neither queued nor started. Queue it instead of starting
			// a turn against a context that is still being compacted.
			if (canQueueDuringAutoCompaction && !this.isStreaming) {
				if (options?.thinkingLevel !== undefined) {
					throw new Error("Cannot set thinkingLevel on a queued prompt; set it after the current turn completes.");
				}
				// Queued, not started: release the start claim before enqueueing, or a claimed start diverts it.
				releaseStart(false);
				if (options?.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, { ...options, inputId });
				} else {
					await this._queueSteer(expandedText, currentImages, { ...options, inputId });
				}
				noteJoined();
				emitPendingCommandInvocation();
				await this._queuedInputDispositions.queued(inputId);
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
					// Queued, not started: release the start claim before enqueueing, or a claimed start diverts it.
					releaseStart(false);
					if (options?.streamingBehavior === "followUp") {
						await this._queueFollowUp(expandedText, currentImages, { ...options, inputId });
					} else {
						await this._queueSteer(expandedText, currentImages, { ...options, inputId });
					}
					noteJoined();
					emitPendingCommandInvocation();
					await this._queuedInputDispositions.queued(inputId);
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
				// Queued, not started: release the start claim before enqueueing, or a claimed start diverts it.
				releaseStart(false);
				if (options?.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, { ...options, inputId });
				} else {
					await this._queueSteer(expandedText, currentImages, { ...options, inputId });
				}
				noteJoined();
				emitPendingCommandInvocation();
				await this._queuedInputDispositions.queued(inputId);
				promptDisposition?.("queued");
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			if (this._extensionBindingPromptReadiness === undefined && !this._lifecycleBinding.isRestored)
				await this._lifecycleBinding.restore();
			await this._assertModelReadyForTurn();

			// The user's new prompt is sent below, so do not call agent.continue() here.
			await this._enforceCompactionBeforeProvider(this._findLastAssistantMessage(), false, "pre_prompt");

			// Build messages array (environment context if it changed, user message, then custom messages)
			messages = [];
			const environmentContext = this._pendingEnvironmentContextMessage();
			if (environmentContext) messages.push(environmentContext);

			// Add user message
			// Claim before awaiting: another idle prompt or capture owns only the entries left behind.
			const releaseExtras = this._releaseExtras.splice(0);
			consumedReleaseExtras = releaseExtras;
			const turnInput = this._engineTurnInput.messages();
			if (releaseExtras.length > 0) {
				const prepared = await Promise.allSettled(releaseExtras);
				// A rejected preparation is dropped, not restored to fail every later prompt.
				consumedReleaseExtras = releaseExtras.filter((_, index) => prepared[index]?.status === "fulfilled");
				const rejected = prepared.find((result) => result.status === "rejected");
				if (rejected !== undefined) throw rejected.reason;
				messages.push(...prepared.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
			}
			messages.push(...turnInput);
			const userContent: (TextContent | ImageContent)[] = userTextContent(expandedText, options?.textBlocks);
			if (currentImages) {
				userContent.push(...currentImages);
			}
			const userMessage: AgentMessage = {
				role: "user",
				content: userContent,
				timestamp: Date.now(),
				...clientMessageIdentity(options),
			};
			this._userInputSources.set(userMessage, options?.source ?? "interactive");
			messages.push(userMessage);

			// Consume next-turn messages transactionally: a final admission rejection
			// restores them in their original order rather than dropping or duplicating
			// one-shot extension state.
			consumedNextTurnMessages = this._pendingNextTurnMessages;
			this._pendingNextTurnMessages = [];
			for (const msg of consumedNextTurnMessages) {
				messages.push(msg);
			}

			// Emit before_agent_start extension event
			this._refreshToolDeclarationsForModel();
			this._promptCachePrefixBuilds.cancelAll();
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			this._applyBeforeAgentStartResult(messages, result, userMessage);

			// The preflight above only sees persisted session context. These prompt,
			// next-turn, and before_agent_start additions are also provider-visible,
			// so make one final admission decision against the complete request.
			await this._enforceFinalProviderAdmission(messages);
			throwIfCancelled();
			if (options.observedPauseSeq !== undefined && this._stopAddedSince(options.observedPauseSeq)) {
				// A Stop landed after this input was accepted: keep it for the next release (senpi#3811 test 3).
				this._holdPreparedInput(expandedText, currentImages, options);
				if (consumedNextTurnMessages !== undefined && consumedNextTurnMessages.length > 0)
					this._pendingNextTurnMessages = [...consumedNextTurnMessages, ...this._pendingNextTurnMessages];
				options.onHeldByNewerStop?.();
				await emitInputDisposition("handled");
				promptDisposition?.("handled");
				preflightResult?.(true);
				messages = undefined;
				return;
			}
			await emitInputDisposition("started");
		} catch (error) {
			await emitInputDisposition("rejected");
			if (consumedReleaseExtras !== undefined)
				this._releaseExtras.unshift(...consumedReleaseExtras.filter((extra) => !this._releaseExtras.includes(extra)));
			if (consumedNextTurnMessages && consumedNextTurnMessages.length > 0) {
				this._pendingNextTurnMessages = [...consumedNextTurnMessages, ...this._pendingNextTurnMessages];
			}
			preflightResult?.(false);
			throw error;
		} finally {
			// Resolved before the run starts below, so a joiner enqueues into this turn.
			releaseStart(messages !== undefined);
		}

		if (!messages) {
			return;
		}

		if (options?.toolBarrier) this._toolBarrier.arm(options.toolBarrier);
		// Everything after arm() sits inside the try: a caller callback that throws must not leave the barrier armed.
		try {
			promptDisposition?.("started");
			emitPendingCommandInvocation();
			preflightResult?.(true);
			if (options?.thinkingLevel !== undefined) {
				this.setSessionThinkingLevel(options.thinkingLevel);
			}
			await this._promptAgent(messages, {
				inputOrigin: originOf(options),
				onQueuedInput: options?.onQueuedInput,
				onTurnAdmitted: options?.onTurnAdmitted,
			});
		} catch (error) {
			// A turn the engine refused never ran, so it releases the barrier it armed (senpi#4106).
			if (options?.toolBarrier && !this._isAgentRunActive) this._toolBarrier.release(options.toolBarrier.id);
			throw error;
		}
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

	/** Apply before_agent_start additions and reset any prior turn's system-prompt override. */
	private _applyBeforeAgentStartResult(
		messages: AgentMessage[],
		result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>,
		prompt: AgentMessage,
	): void {
		if (result?.messages) {
			for (const msg of result.messages) {
				const index = msg.placement === "before-prompt" ? messages.indexOf(prompt) : messages.length;
				messages.splice(index, 0, {
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
		if (result?.systemPrompt !== undefined) {
			this._systemPromptOverride = result.systemPrompt;
			this.agent.state.systemPrompt = result.systemPrompt;
		} else {
			// Ensure we're using the base prompt (in case a previous turn had modifications).
			this._systemPromptOverride = undefined;
			this.agent.state.systemPrompt = this._baseSystemPrompt;
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
		this._emit({
			type: "command_invocation",
			command: {
				name: commandName,
				source: "extension",
				sourceInfo: command.sourceInfo,
				syntax: "slash",
			},
		});

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
	 * Throw `UnknownCommandError` when `text` is command-shaped and no extension command, prompt
	 * template, or loaded skill resolves it. Runs after input transforms and expansion, so extension
	 * rewrites and expanded commands never reach here as unknown.
	 */
	private _rejectUnknownCommand(text: string): void {
		if (commandShapedName(text) === undefined) return;
		const promptCommands = new Set<string>([
			...this._extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
			...this.promptTemplates.map((template) => template.name),
			...this.resourceLoader.getSkills().skills.map((skill) => `skill:${skill.name}`),
		]);
		const interactiveCommands = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		const rejection = findUnknownCommand(text, { promptCommands, interactiveCommands });
		if (rejection) throw rejection;
	}

	/**
	 * Expand explicit skill invocations to their full content.
	 * Leading runs accept slash and dollar syntax; inline `$name` expands only when
	 * it names a loaded skill, so ordinary dollar prose such as `$HOME` stays literal.
	 */
	private _expandSkillCommand(text: string): string | Promise<string> {
		const skills = this.resourceLoader.getSkills().skills;
		const invocationTokens = parseSkillInvocationTokens(text, {
			knownSkillNames: new Set(skills.map((skill) => skill.name)),
		});
		if (invocationTokens.length === 0) return text;
		return this._expandSkillTokens(text, skills, invocationTokens);
	}

	private async _expandSkillTokens(
		text: string,
		skills: readonly Skill[],
		invocationTokens: readonly SkillInvocationToken[],
	): Promise<string> {
		const maxExpansions = this.settingsManager.getMaxSkillExpansionsPerPrompt();

		const expandedSkillNames = new Set<string>();
		const skillBlocks: SkillInvocationPromptSkill[] = [];
		const invocationMetadata: Array<{
			name: string;
			path: string;
			syntax: SkillInvocationSyntax;
		}> = [];
		const removedTokens: SkillInvocationToken[] = [];
		const unloadedTokens = new Set<SkillInvocationToken>();
		const skippedSkillNames: string[] = [];

		for (const token of invocationTokens) {
			const skill = skills.find((candidate) => candidate.name === token.name);
			if (!skill) {
				if (token.position === "leading") break;
				continue;
			}

			// A repeat of an already expanded skill adds no context, so it never counts
			// against the cap and keeps its positional marker.
			if (expandedSkillNames.has(skill.name)) {
				removedTokens.push(token);
				this._extensionRunner.emitError({
					extensionPath: skill.filePath,
					event: "skill_expansion",
					error: `Skipped duplicate skill invocation: ${skill.name}`,
				});
				continue;
			}

			if (skillBlocks.length >= maxExpansions) {
				removedTokens.push(token);
				unloadedTokens.add(token);
				if (!skippedSkillNames.includes(skill.name)) skippedSkillNames.push(skill.name);
				continue;
			}

			removedTokens.push(token);

			try {
				const content = await readSkillFileChecked(skill.filePath, skill.provenance, skill.allowedSet);
				const body = stripFrontmatter(content).trim();
				skillBlocks.push({
					name: skill.name,
					filePath: skill.filePath,
					baseDir: skill.baseDir,
					body,
				});
				expandedSkillNames.add(skill.name);
				invocationMetadata.push({
					name: skill.name,
					path: skill.filePath,
					syntax: token.syntax,
				});
			} catch (err) {
				if (err instanceof BlockedSkillLinkError) {
					this.securityNotices.add({ category: "skill-link-blocked", message: err.message, path: skill.filePath });
				}
				this._extensionRunner.emitError({
					extensionPath: skill.filePath,
					event: "skill_expansion",
					error: err instanceof Error ? err.message : String(err),
				});
				return text; // Return the original prompt when any skill file cannot be read.
			}
		}

		if (skippedSkillNames.length > 0) {
			const count = skippedSkillNames.length;
			this._extensionRunner.emitError({
				extensionPath: "skill:expansion",
				event: "skill_expansion",
				error: `Skipped ${count} skill${count === 1 ? "" : "s"} (${skippedSkillNames.join(", ")}): at most ${maxExpansions} skills load per prompt. Raise maxSkillExpansionsPerPrompt to load more.`,
			});
		}
		if (skillBlocks.length === 0) return text;
		const userRequest = removeSkillInvocationTokens(text, removedTokens, unloadedTokens);
		this._emit({ type: "skill_invocation", skills: invocationMetadata });
		return formatSkillInvocationPrompt(skillBlocks, userRequest);
	}

	/**
	 * Shared queueing path for `steer()` and `followUp()`: extension-command guard,
	 * `input` handlers, skill/template expansion, then the recovery-ordered enqueue.
	 */
	private _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		options?: QueuedInputOptions,
	): Promise<QueuedInputDisposition> {
		const hold = this.externalAdmission.beginInput();
		if (originOf(options) === "person" && this._engineTurnHold.held)
			return this._promptHeldQueuedInput(text, images, behavior, options, hold);
		// The caller awaits the admission itself: the hold is released beside it, so holding the input adds no
		// turns to a caller that queues several inputs before the run drains its steering queue.
		const admitted = this._admitQueuedInput(text, images, behavior, options);
		admitted.then(hold.end, hold.end);
		return admitted;
	}

	private async _promptHeldQueuedInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		options: QueuedInputOptions | undefined,
		hold: InputHold,
	): Promise<QueuedInputDisposition> {
		try {
			await this.prompt(text, {
				...options,
				images,
				streamingBehavior: behavior,
				humanInputReported: true,
				promptDisposition: (disposition) => {
					if (disposition !== "started") hold.accepted();
				},
				onTurnAdmitted: () => hold.accepted(),
			});
			return "queued";
		} finally {
			hold.end();
		}
	}

	private async _admitQueuedInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		options?: QueuedInputOptions,
	): Promise<QueuedInputDisposition> {
		if (originOf(options) === "person") this._beginPersonInput();
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await this._runInputHandlers(
			text,
			images,
			options?.source ?? "interactive",
			attributionOf(options),
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return "handled";

		// Expand skill commands and prompt templates
		const skillExpansion = this._expandSkillCommand(processedInput.text);
		let expandedText = typeof skillExpansion === "string" ? skillExpansion : await skillExpansion;
		const templateExpansion = expandPromptTemplateWithMetadata(expandedText, [...this.promptTemplates]);
		expandedText = templateExpansion.text;

		const queuedOptions = { ...options, inputId: processedInput.inputId };
		if (behavior === "steer") {
			await this._queueSteer(expandedText, processedInput.images, queuedOptions);
		} else {
			await this._queueFollowUp(expandedText, processedInput.images, queuedOptions);
		}
		await this._queuedInputDispositions.queued(processedInput.inputId);
		if (templateExpansion.template) {
			this._emit({
				type: "command_invocation",
				command: {
					name: templateExpansion.template.name,
					source: "prompt",
					sourceInfo: templateExpansion.template.sourceInfo,
					syntax: "slash",
				},
			});
		}
		return "queued";
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Runs `input` extension handlers, then expands skill commands and prompt templates.
	 * Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Recovery enqueue order and input source; source defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], options?: QueuedInputOptions): Promise<QueuedInputDisposition> {
		if (isHumanInput(options)) this._humanInputAdmitted("steer");
		return this._queueUserInput(text, images, "steer", options);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Runs `input` extension handlers, then expands skill commands and prompt templates.
	 * Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Recovery enqueue order and input source; source defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: QueuedInputOptions,
	): Promise<QueuedInputDisposition> {
		if (isHumanInput(options)) this._humanInputAdmitted("follow_up");
		return this._queueUserInput(text, images, "followUp", options);
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
			// A title is a background, cosmetic job: its auth retry is cancellable with the title and reports
			// nothing to the UI (no retry banner or summary spinner for a job the user never started).
			const auth = await this._getSummarizationRequestAuth(model, abortController.signal, {});
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
			// A missing title is cosmetic, so the failure stays out of the runtime-error surface.
			this._sessionLogger.debug("session_title_failed", {
				error: error instanceof Error ? error.message : String(error),
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
	private async _queueSteer(
		text: string,
		images?: ImageContent[],
		options?: QueuedInputOptions & Pick<PromptOptions, "textBlocks"> & QueuedInputEventId,
	): Promise<void> {
		await this._enqueueQueuedInput({ ...options, text, images, mode: "steer" });
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(
		text: string,
		images?: ImageContent[],
		options?: QueuedInputOptions & Pick<PromptOptions, "textBlocks"> & QueuedInputEventId,
	): Promise<void> {
		await this._enqueueQueuedInput({ ...options, text, images, mode: "followUp" });
	}

	/** Identified input is admitted into durable custody and enqueued in one gated step; other input as before. */
	private async _enqueueQueuedInput(
		input: QueuedInputOptions &
			Omit<PreparedClientInput, "enqueueOrder"> &
			Pick<PromptOptions, "textBlocks"> &
			QueuedInputEventId,
	): Promise<void> {
		const clientMessageId = input.clientMessageId;
		const sourced = { ...input, source: input.source ?? "interactive" };
		if (clientMessageId === undefined) {
			this._enqueuePreparedInput(sourced);
			return;
		}
		await this._pendingInputs.admit(
			{ clientMessageId, text: input.text, ...(input.images ? { images: input.images } : {}), mode: input.mode },
			(queuedId) => this._enqueuePreparedInput({ ...sourced, queuedId }),
		);
	}

	/** Restore accepted input without re-running input transforms or changing its enqueue order. */
	async restoreQueuedInput(input: PreparedClientInput): Promise<void> {
		const restored =
			input.clientMessageId === undefined
				? undefined
				: await this._pendingInputs.restoreHandle(input.clientMessageId);
		// The pending-input record is the authority: an input it already retired is not queued again.
		if (restored === "retired") return;
		this._enqueuePreparedInput(restored === undefined ? input : { ...input, queuedId: restored.queuedId });
	}

	private _enqueuePreparedInput(
		input: QueuedInputOptions &
			Omit<PreparedClientInput, "enqueueOrder"> &
			Pick<PromptOptions, "textBlocks"> &
			QueuedInputEventId & { readonly queuedId?: string },
	): void {
		const enqueueOrder = input.enqueueOrder ?? this.reserveQueuedInputOrder();
		const prepared = {
			...clientMessageIdentity(input),
			text: input.text,
			images: input.images,
			mode: input.mode,
			enqueueOrder,
			...(input.source === undefined ? {} : { source: input.source }),
		};
		input.onQueuedInput?.(prepared);
		const queue = input.mode === "steer" ? this._steeringMessages : this._followUpMessages;
		queue.push(input.text);
		const queuedId = this._recordQueuedInput(input.text, input.mode, prepared, undefined, input.queuedId);
		if (originOf(input) === "person") this._personQueuedIds.add(queuedId);
		this._sessionLogger.debug("queue_enqueue", {
			mode: input.mode,
			count: queue.length,
		});
		const content: (TextContent | ImageContent)[] = [
			...userTextContent(input.text, input.textBlocks),
			...(input.images ?? []),
		];
		const message: AgentMessage = {
			role: "user",
			content,
			timestamp: Date.now(),
			...clientMessageIdentity(input),
		};
		// New input always arrives with a source: `_enqueueQueuedInput` applies the same "interactive" default
		// `prompt()` does. Only restored input can lack one (a record written before sources were kept), and it
		// stays unstamped: unknown origin, never defaulted to a trusted source.
		if (input.source !== undefined) this._userInputSources.set(message, input.source);
		if (input.inputId !== undefined) this._queuedInputDispositions.track(message, input.inputId);
		this._queuedMessages.set(queuedId, message);
		if (this._promptStartPending && this._skipNextPostCompactionAssistantCheck) {
			const deferred =
				input.mode === "steer"
					? this._postCompactionDeferredSteeringMessages
					: this._postCompactionDeferredFollowUpMessages;
			deferred.push(message);
		} else if (input.mode === "steer") {
			this.agent.steer(message);
		} else {
			this.agent.followUp(message);
		}
		// Announce the input only once it is queued everywhere, so a listener can already change it by queuedId.
		this._emitQueueUpdate();
	}

	private _flushPostCompactionDeferredMessages(): void {
		const steering = this._postCompactionDeferredSteeringMessages;
		const followUps = this._postCompactionDeferredFollowUpMessages;
		this._postCompactionDeferredSteeringMessages = [];
		this._postCompactionDeferredFollowUpMessages = [];
		this._requeueAtOriginalPlace(steering, "steer");
		this._requeueAtOriginalPlace(followUps, "followUp");
	}

	/**
	 * Hand parked input back to the agent queue at the place it was sent: newer input of the same mode that was
	 * queued meanwhile is moved behind it, so delivery keeps the order the input was sent in (#4036).
	 */
	private _requeueAtOriginalPlace(parked: readonly AgentMessage[], mode: QueuedInput["mode"]): void {
		if (parked.length === 0) return;
		const enqueueOrderOf = new Map<AgentMessage, number>();
		for (const input of this._queuedInputOrder) {
			const message = this._queuedMessages.get(input.queuedId);
			if (message !== undefined) enqueueOrderOf.set(message, input.enqueueOrder);
		}
		const orderOf = (message: AgentMessage): number => enqueueOrderOf.get(message) ?? Number.POSITIVE_INFINITY;
		const oldestParked = Math.min(...parked.map(orderOf));
		const parkedSet = new Set(parked);
		const newer = this._queuedInputOrder
			.filter((input) => input.mode === mode && input.enqueueOrder > oldestParked)
			.map((input) => this._queuedMessages.get(input.queuedId))
			.filter(
				(message): message is AgentMessage =>
					message !== undefined && !parkedSet.has(message) && this.agent.removeQueuedMessage(message),
			);
		for (const message of [...parked, ...newer].sort((a, b) => orderOf(a) - orderOf(b))) {
			if (mode === "steer") this.agent.steer(message);
			else this.agent.followUp(message);
		}
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

	/** Whether a triggered automatic wake reaches the hold gate at all (senpi#3811). */
	private _wakeGateApplies(
		customType: string,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
	): boolean {
		return (
			(customTurnOrigin(customType) === "engine" ||
				this._lifecycleBinding.controller.requiresHumanContinuation) &&
			options?.deliverAs !== "nextTurn" &&
			options?.triggerTurn !== false &&
			(this.isStreaming || options?.triggerTurn === true)
		);
	}

	/** An itemized batch, admitted where a plain `sendMessage` is, answering one receipt per item (design 4.5). */
	private _sendItemizedMessage<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options: SendMessageOptions & { items: readonly SendMessageItem[] },
	): Promise<readonly SendMessageReceipt[]> {
		const receipts = Promise.withResolvers<readonly SendMessageReceipt[]>();
		const admit = (claim?: DeferredTurnClaim): void => {
			this._admitItemized(message, options, claim).then(receipts.resolve, (error: unknown) => {
				if (error instanceof ModelNotReadyError) this._noticeProviderRequired(error.message);
				receipts.reject(error);
			});
		};
		if (options.triggerTurn === true && this._agentSettledDelivery.deferTriggerTurn((claim) => admit(claim)))
			return receipts.promise;
		if (!this._agentSettledDelivery.defer(() => admit())) admit();
		return receipts.promise;
	}

	/**
	 * The atomic admission of an itemized batch: if a live hold applies to the batch or to any item (by that item's
	 * producer and run), every item becomes its own notice, all in one entry; otherwise the batch is delivered as one
	 * message and every item's receipt names the entry that message was written to. Async so a failed write rejects
	 * the receipts even on a deferred path; the held branch still decides custody before its first await.
	 */
	private async _admitItemized<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options: SendMessageOptions & { items: readonly SendMessageItem[] },
		claim?: DeferredTurnClaim,
	): Promise<readonly SendMessageReceipt[]> {
		const { items } = options;
		const held =
			this._wakeGateApplies(message.customType, options) &&
			(this._holdForInterruptedRun(options) ||
				this._engineTurnHold.holdsSource(engineWakeSource(message.customType)) ||
				this._runHolds.holdsWake(message.details) ||
				items.some(
					(item) =>
						this._engineTurnHold.holdsSource(item.producer) || this._runHolds.holdsWake({ runRef: item.runRef }),
				));
		if (held) {
			claim?.resolve("finished-without-start");
			// The ticket is admitted before any notice is written: a refused one keeps no item (senpi#3864).
			if (options.ticket !== undefined) {
				const admission = this.workObligations.admission(options.ticket);
				if (admission !== "admitted") throw new DeliveryTicketRefused(options.ticket, admission);
			}
			const notices = this._engineTurnHold.noteItems(
				items.map((item) => ({ source: item.producer, message: itemNoticeMessage(message, item), item })),
			);
			// senpi#3864: the batch's delivery ticket moves into the held notices, as a plain held send's does.
			const firstNotice = notices[0];
			if (options.ticket !== undefined && firstNotice !== undefined)
				this.workObligations.held(options.ticket, firstNotice.noticeId);
			return notices.map((notice) => ({ ...notice, disposition: "notice_persisted" as const }));
		}
		const outcome = Promise.withResolvers<readonly SendMessageReceipt[]>();
		this.sendCustomMessage(message, options, claim, undefined, {
			persisted: (entryId) => outcome.resolve(deliveredReceipts(items, entryId)),
			failed: outcome.reject,
			droppedByAbort: () => {
				this._admitItemized(message, options).then(outcome.resolve, outcome.reject);
			},
			itemIds: items.map((item) => item.itemId),
		}).catch(outcome.reject);
		return outcome.promise;
	}

	/** A re-send of a queued ticket shares the queued message's outcome instead of waiting on a message never written. */
	private _joinPersistWatcher(carrier: AgentMessage, joined: PersistWatcher): void {
		const first = this._persistWatchers.get(carrier);
		this._persistWatchers.set(
			carrier,
			first === undefined
				? joined
				: {
						persisted: (entryId) => {
							first.persisted(entryId);
							joined.persisted(entryId);
						},
						failed: (error) => {
							first.failed(error);
							joined.failed(error);
						},
						itemIds: first.itemIds,
					},
		);
	}

	/** The queued message that already carries this ticket, if any. */
	private _queuedTicketCarrier(ticket: string): AgentMessage | undefined {
		return [...this.agent.peekQueuedMessages({ all: true }), ...this._pendingNextTurnMessages].find(
			(queued) => queued.role === "custom" && messageTicket(queued) === ticket,
		);
	}

	private _recordWrittenTicket(message: AgentMessage, entryId: string): void {
		const ticket = message.role === "custom" ? messageTicket(message) : undefined;
		if (ticket !== undefined && this._carrierJoiners.has(ticket)) this._writtenTicketEntries.set(ticket, entryId);
	}

	private _takePersistWatcher(message: AgentMessage): PersistWatcher | undefined {
		const watcher = this._persistWatchers.get(message);
		this._persistWatchers.delete(message);
		return watcher;
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
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; ticket?: string },
		deferredTurnClaim?: DeferredTurnClaim,
		releasedWake?: () => boolean,
		itemized?: ItemizedAdmission,
		onQueued?: () => void,
	): Promise<void> {
		// Normalize the legacy untyped content boundary before persisting a retry payload.
		const deliveryMessage = { ...message, content: message.content ?? [] };
		if (this._sizesOnlyStartup && options?.triggerTurn === true) {
			// Size inspection makes no model call (#3483) and owes no work: no ticket, custody record or session file.
			this._pendingNextTurnMessages.push({ role: "custom", ...deliveryMessage, timestamp: Date.now() } satisfies CustomMessage);
			deferredTurnClaim?.resolve("finished-without-start");
			return;
		}
		const obligations = this.workObligations;
		const deliveryId = deliveryIdOf({ ...deliveryMessage, role: "custom", timestamp: Date.now() });
		// A next-turn message waits for a person's turn, so it is never work the engine owes.
		const engineTicket =
			options?.ticket === undefined &&
			options?.deliverAs !== "nextTurn" &&
			(this.isStreaming || options?.triggerTurn === true)
				? obligations
						.open(
							`${ENGINE_DELIVERY_KEY_PREFIX}${message.customType}:${deliveryId ?? randomUUID()}`,
							"background",
						)
						.ticket()
				: undefined;
		const ticket = options?.ticket ?? engineTicket;
		const generation = this._userAbortGeneration;
		// The same ticket admission as the held branch, before the payload is queued (senpi#3864).
		const admission = ticket === undefined ? "admitted" : obligations.admission(ticket);
		if (ticket !== undefined && admission !== "admitted") {
			deferredTurnClaim?.resolve("finished-without-start");
			if (itemized !== undefined) {
				itemized.failed(new DeliveryTicketRefused(ticket, admission));
				return;
			}
			// A plain send keeps its contract: an unknown ticket is a custody violation, a settled one is a no-op.
			if (admission === "unknown") throw new CustodyViolation(ticket);
			return;
		}
		// A re-send of a queued ticket must not replace the payload that queued message will write (senpi#4106).
		const queuedCarrier = ticket === undefined ? undefined : this._queuedTicketCarrier(ticket);
		// A carrier restored after a restart has no watcher; its custody payload still records the batch's items.
		const carrierItems =
			queuedCarrier && ticket !== undefined
				? (this._persistWatchers.get(queuedCarrier)?.itemIds ?? obligations.queuedItemIds(ticket))
				: undefined;
		if (ticket !== undefined && itemized?.itemIds && carrierItems && !sameItems(carrierItems, itemized.itemIds)) {
			deferredTurnClaim?.resolve("finished-without-start");
			itemized.failed(new DeliveryTicketRefused(ticket, "different_items"));
			return;
		}
		if (ticket && queuedCarrier === undefined) this._writtenTicketEntries.delete(ticket);
		const joinsCarrier = ticket !== undefined && queuedCarrier !== undefined;
		if (joinsCarrier) this._carrierJoiners.set(ticket, (this._carrierJoiners.get(ticket) ?? 0) + 1);
		if (ticket && queuedCarrier === undefined)
			obligations.queue(ticket, {
				message: deliveryMessage,
				deliverAs: options?.deliverAs,
				...(itemized?.itemIds ? { itemIds: itemized.itemIds } : {}),
			});
		onQueued?.();
		// A batch a user abort (Esc or Stop) dropped is decided again only after this delivery releases its ticket.
		let readmit = false;
		const delivery: ItemizedAdmission | undefined =
			itemized === undefined
				? undefined
				: {
						persisted: itemized.persisted,
						failed: itemized.failed,
						droppedByAbort: () => {
							readmit = true;
						},
						itemIds: itemized.itemIds,
					};
		try {
			const startsTurn = options?.triggerTurn === true && !this.isStreaming;
			if (startsTurn) this._pendingCustomTurnHeaders++;
			try {
				await this.sessionManager.persistHeaderNow();
			} finally {
				if (startsTurn) this._pendingCustomTurnHeaders--;
			}
			if (generation !== this._userAbortGeneration) {
				if (ticket) this._retireLifecycleDelivery(ticket, !this._isEngineDelivery(ticket));
				deferredTurnClaim?.resolve("finished-without-start");
				readmit = itemized !== undefined;
				return;
			}
			await this._deliverCustomMessage(
				deliveryMessage,
				{ ...options, ticket, ...(queuedCarrier !== undefined ? { joinsQueuedCarrier: true } : {}) },
				deferredTurnClaim,
				releasedWake,
				delivery,
			);
			if (ticket && generation !== this._userAbortGeneration) {
				const retainedForLater = [
					...this.agent.peekQueuedMessages({ all: true }),
					...this._pendingNextTurnMessages,
				].some((queued) => queued.role === "custom" && messageTicket(queued) === ticket);
				if (!retainedForLater) this._retireLifecycleDelivery(ticket, !this._isEngineDelivery(ticket));
			}
		} catch (error) {
			if (ticket) obligations.failed(ticket);
			throw error;
		} finally {
			if (ticket) obligations.endDelivery(ticket);
			if (joinsCarrier) this._leaveCarrier(ticket);
			if (readmit) itemized?.droppedByAbort();
		}
	}

	private _leaveCarrier(ticket: string): void {
		const joiners = (this._carrierJoiners.get(ticket) ?? 1) - 1;
		if (joiners > 0) {
			this._carrierJoiners.set(ticket, joiners);
			return;
		}
		this._carrierJoiners.delete(ticket);
		this._writtenTicketEntries.delete(ticket);
	}

	private _queuedDeliveryTickets(): string[] {
		return this.agent.peekQueuedMessages({ all: true }).flatMap((queued) => {
			const ticket = queued.role === "custom" ? messageTicket(queued) : undefined;
			return ticket === undefined ? [] : [ticket];
		});
	}

	/** Read from the durable custody key, so a delivery re-sent from custody after a restart is still the engine's. */
	private _isEngineDelivery(ticket: string): boolean {
		return this.workObligations.active.some(
			(record) => record.ticketId === ticket && record.key.startsWith(ENGINE_DELIVERY_KEY_PREFIX),
		);
	}

	/**
	 * senpi#3864: a queued delivery that leaves the queue unconsumed is no longer work the engine owes. A cleared
	 * one is cancelled (a producer keeps its own ticket open without the payload); one an abort left queued waits
	 * for a person's turn, so its engine ticket turns passive.
	 */
	private _releaseQueuedDeliveries(tickets: readonly string[], cause: "cleared" | "aborted"): void {
		for (const ticket of tickets) {
			const engineOwned = this._isEngineDelivery(ticket);
			if (cause === "cleared") {
				if (engineOwned) this.workObligations.cancel(ticket);
				else this.workObligations.retire(ticket);
			} else if (engineOwned) this.workObligations.passive(ticket);
		}
	}

	/** A removed itemized message is never written: every send waiting on it settles now (senpi#4106). */
	private _settleRemovedCarriers(removed: readonly AgentMessage[]): void {
		for (const message of removed) {
			const watcher = this._takePersistWatcher(message);
			watcher?.failed(new QueuedDeliveryCleared(watcher.itemIds));
		}
	}

	private _retireLifecycleDelivery(ticket: string, producerOwned: boolean): void {
		const removed: AgentMessage[] = [];
		for (const queued of this.agent.peekQueuedMessages({ all: true })) {
			if (queued.role === "custom" && messageTicket(queued) === ticket) {
				this.agent.removeQueuedMessage(queued);
				removed.push(queued);
			}
		}
		this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter((queued) => {
			const carriesTicket = messageTicket(queued) === ticket;
			if (carriesTicket) removed.push(queued);
			return !carriesTicket;
		});
		this._settleRemovedCarriers(removed);
		if (producerOwned) this.workObligations.retire(ticket);
		else this.workObligations.cancel(ticket);
	}

	private async _deliverCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			ticket?: string;
			/** The send found the ticket's message queued when it was admitted, so it expects to join that carrier. */
			joinsQueuedCarrier?: boolean;
		},
		deferredTurnClaim?: DeferredTurnClaim,
		releasedWake?: () => boolean,
		itemized?: ItemizedAdmission,
	): Promise<void> {
		const userAbortGeneration = this._userAbortGeneration;
		const queuedCarrier = options?.ticket === undefined ? undefined : this._queuedTicketCarrier(options.ticket);
		if (queuedCarrier !== undefined) {
			// The ticket's message is already queued: this send's receipts settle when that message is written.
			if (itemized !== undefined) this._joinPersistWatcher(queuedCarrier, itemized);
			deferredTurnClaim?.resolve("delegated");
			return;
		}
		// A re-send that found the ticket's carrier queued and lost it while it waited is never written: if the running
		// turn wrote the carrier, the re-send settles with that entry (its items matched the carrier's); if a clear or a
		// retire removed it, writing it would deliver a cleared message under a retired ticket, so it settles as cleared
		// (an itemized send's receipts fail with QueuedDeliveryCleared; a plain send has none).
		if (options?.joinsQueuedCarrier === true && options.ticket !== undefined) {
			const writtenEntry = this._writtenTicketEntries.get(options.ticket);
			if (writtenEntry !== undefined) {
				itemized?.persisted(writtenEntry);
				deferredTurnClaim?.resolve("delegated");
				return;
			}
			deferredTurnClaim?.resolve("finished-without-start");
			itemized?.failed(new QueuedDeliveryCleared(itemized.itemIds));
			return;
		}
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: options?.ticket
				? {
						...(typeof message.details === "object" && message.details !== null && !Array.isArray(message.details)
							? message.details
							: message.details === undefined
								? {}
								: { producerDetails: message.details }),
						ticketId: options.ticket,
					}
				: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage;
		if (this._sizesOnlyStartup && options?.triggerTurn === true) {
			// Size inspection makes no model call (#3483): keep the message for a turn that never starts.
			this._pendingNextTurnMessages.push(appMessage);
			deferredTurnClaim?.resolve("finished-without-start");
			return;
		}
		if (itemized !== undefined) this._persistWatchers.set(appMessage, itemized);
		if (
			!releasedWake &&
			this._wakeGateApplies(message.customType, options) &&
			(this._holdForInterruptedRun(options) ||
				this._engineTurnHold.holdsSource(engineWakeSource(message.customType)) ||
				this._runHolds.holdsWake(message.details))
		) {
			this._noteHeldWake(appMessage, options?.ticket);
			deferredTurnClaim?.resolve("finished-without-start");
			return;
		}
		const waitForExistingSessionWork =
			options?.triggerTurn === true &&
			options.deliverAs !== "nextTurn" &&
			!this.isStreaming &&
			this._sessionWorkBarrier.hasActiveWork &&
			// The session-start binding itself holds the barrier while it emits
			// session_start; a triggerTurn message queued from that emission (e.g. a
			// goal continuation) must not wait on the very work that is delivering it.
			this._extensionBindingPromptReadiness === undefined;
		const pendingCompactionAdmission = this._pendingCompactionAdmission;
		const activeCompactionGeneration =
			this._compactionLifecycle.state.status === "running" ? this._compactionLifecycle.state.generation : undefined;
		let finishSessionWork: (() => void) | undefined;
		try {
			if (waitForExistingSessionWork) {
				await this._waitForSettledSessionWork();
				if (userAbortGeneration !== this._userAbortGeneration) {
					// A plain wake is dropped here; an itemized batch is decided again so no item leaves custody.
					this._persistWatchers.delete(appMessage);
					itemized?.droppedByAbort();
					return;
				}
				finishSessionWork = this._sessionWorkBarrier.begin();
			}

			if (options?.deliverAs === "nextTurn") {
				this._pendingNextTurnMessages.push(appMessage);
			} else if (this.isStreaming && options?.triggerTurn !== false) {
				if (releasedWake) return;
				deferredTurnClaim?.resolve("delegated");
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
				if (releasedWake) return;
				deferredTurnClaim?.resolve("delegated");
				if (options?.deliverAs === "followUp") {
					this.agent.followUp(appMessage);
				} else {
					this.agent.steer(appMessage);
				}
			} else if (options?.triggerTurn && this._stopEngineTurn(message.customType)) {
				if (!releasedWake) this._recordRefusedEngineTurnMessage(appMessage);
			} else if (options?.triggerTurn) {
				finishSessionWork ??= this._sessionWorkBarrier.begin();
				const environmentContext = this._pendingEnvironmentContextMessage();
				const messages: AgentMessage[] = environmentContext ? [environmentContext, appMessage] : [appMessage];
				const queueTriggerForLater = (): void => {
					// A released wake stays in notice custody until final admission claims it.
					if (releasedWake) return;
					if (options.deliverAs === "followUp") {
						this.agent.followUp(appMessage);
					} else {
						this.agent.steer(appMessage);
					}
				};
				this._triggerTurnAdmissionAbortGeneration = userAbortGeneration;
				try {
					if (this._extensionBindingPromptReadiness === undefined && !this._lifecycleBinding.isRestored)
						await this._lifecycleBinding.restore();
					await this._assertModelReadyForTurn();
					await this._enforceCompactionBeforeProvider(this._findLastAssistantMessage(), false, "pre_prompt");
					this._refreshToolDeclarationsForModel();
					this._promptCachePrefixBuilds.cancelAll();
					const result = await this._extensionRunner.emitBeforeAgentStart(
						contentText(appMessage.content, ""),
						undefined,
						this._baseSystemPrompt,
						this._baseSystemPromptOptions,
						{
							trigger: deliveryIdOf(appMessage) === undefined ? "extension" : "delivery",
						},
					);
					if (userAbortGeneration !== this._userAbortGeneration) {
						queueTriggerForLater();
						return;
					}
					this._applyBeforeAgentStartResult(messages, result, appMessage);
					await this._enforceFinalProviderAdmission(messages);
					if (userAbortGeneration !== this._userAbortGeneration) {
						queueTriggerForLater();
						return;
					}
				} catch (error) {
					// Mirror sendUserMessage's retention contract: an admission
					// rejection must retain the message for later delivery instead
					// of silently dropping it (the fire-and-forget extension action
					// swallows this rejection).
					queueTriggerForLater();
					throw error;
				} finally {
					this._triggerTurnAdmissionAbortGeneration = undefined;
				}
				// The lifecycle restore awaited above can find the previous run interrupted (senpi#4683). A released
				// wake is still in notice custody, so only a fresh send becomes a notice.
				if (this._wakeGateApplies(message.customType, options) && this._holdForInterruptedRun(options)) {
					if (itemized !== undefined) {
						if (options.ticket) this._retireLifecycleDelivery(options.ticket, !this._isEngineDelivery(options.ticket));
						this._persistWatchers.delete(appMessage);
						itemized.droppedByAbort();
					} else if (!releasedWake) this._noteHeldWake(appMessage, options.ticket);
					return;
				}
				if (releasedWake && !releasedWake()) return;
				const inputOrigin = customTurnOrigin(message.customType);
				if (inputOrigin === "engine") this._recordEngineTurnStart(message.customType);
				await this._promptAgent(messages, { inputOrigin, deferredTurnClaim });
			} else if (this.isStreaming) {
				if (options?.ticket) this.workObligations.passive(options.ticket);
				this._pendingCustomMessages.push(appMessage);
			} else {
				if (options?.ticket) this.workObligations.passive(options.ticket);
				this._appendCustomMessage(appMessage);
			}
		} finally {
			deferredTurnClaim?.resolve("finished-without-start");
			finishSessionWork?.();
		}
	}

	/**
	 * Subscribe to human input as it enters the session: called synchronously for every input whose origin is a
	 * person (TUI input, RPC prompt/steer/follow_up, human question answers, `resumeSession`). Origin comes from
	 * the entry point, never from the connection's `interactive_user` role, which only decides authority. Never
	 * called for automatic deliveries (extension messages, wakes, continuations). A throwing listener does not block
	 * the input. Timing: a call means a person sent it, not that it took effect: `prompt` reports before checks that
	 * can still throw, `resumeSession` reports even when nothing is paused, and TUI messages queued during
	 * compaction report when they are delivered.
	 */
	onHumanInputAdmitted(listener: (event: HumanInputAdmittedEvent) => void): () => void {
		this._humanInputListeners.add(listener);
		return () => this._humanInputListeners.delete(listener);
	}

	/** Internal adapter boundary for a validated reply that resumes the current turn. */
	admitHumanAnswer(): void {
		const input = this.externalAdmission.beginInput();
		try {
			this._humanInputAdmitted("answer");
		} finally {
			input.end();
		}
	}

	private _humanInputAdmitted(kind: HumanInputAdmittedEvent["kind"]): void {
		const event = { kind, at: Date.now() };
		for (const listener of this._humanInputListeners) {
			try {
				listener(event);
			} catch (error) {
				this._sessionLogger.warn("human_input_listener_failed", { error: String(error) });
			}
		}
	}

	/** Explicit user Resume; attachment alone must never call this. */
	resumeSession(): Promise<void> {
		return this.beginResume({}).then(({ settled }) => settled);
	}

	/** Resume and wait until the resumed work has settled (TUI, tests). */
	async resumeSessionRequest(request: ResumeSessionRequest): Promise<ResumeSessionAnswer> {
		const { answer, settled } = await this.beginResume(request);
		await settled;
		return answer;
	}

	/**
	 * Resume after a Stop or an unattended hold (senpi#3811 design 4.9). The answer is ready once the release is
	 * admitted; `settled` resolves when the resumed work has settled. Every request field is optional.
	 */
	async beginResume(request: ResumeSessionRequest): Promise<{ answer: ResumeSessionAnswer; settled: Promise<void> }> {
		this._humanInputAdmitted("resume");
		const replayed = request.effectId === undefined ? undefined : this._resumeEffects.get(request.effectId);
		if (replayed !== undefined) return { answer: { ...replayed, replayed: true }, settled: Promise.resolve() };
		// A resume is a person's input (senpi#3864): no external delivery overtakes it until its turn is queued.
		const input = this.externalAdmission.beginInput();
		let result: { answer: ResumeSessionAnswer; settled: Promise<void> };
		try {
			result = await this._resumeOnce(request, () => input.accepted());
		} catch (error) {
			input.end();
			throw error;
		}
		result.settled.then(input.end, input.end);
		if (request.effectId !== undefined && result.answer.resumed) {
			this._resumeEffects.set(request.effectId, result.answer);
			this._emitEntryAppended(
				this.sessionManager.appendCustomEntry(RESUME_EFFECT_ENTRY, {
					effectId: request.effectId,
					answer: result.answer,
				}),
			);
		}
		return result;
	}

	private async _resumeOnce(
		request: ResumeSessionRequest,
		onQueued?: () => void,
	): Promise<{ answer: ResumeSessionAnswer; settled: Promise<void> }> {
		const pauseSeq = this._engineTurnHold.currentPauseSeq;
		const holds = this._engineTurnHold.holds;
		const idle = { pauseSeq, turnStarted: false, deliveredNotices: 0, deliveredHeldInputs: 0 };
		const answered = (answer: ResumeSessionAnswer) => ({ answer, settled: Promise.resolve() });
		if (holds.length === 0 && !this._engineTurnHold.awaitingInput)
			return answered({ resumed: false, reason: "not_paused", ...idle });
		const inherited = this._runHolds.inheritedOwner();
		if (inherited !== undefined && holds.every((hold) => hold.kind === "inherited_hold"))
			return answered({
				resumed: false,
				reason: "resume_through_parent",
				parentSessionId: inherited.parentSessionId,
				...idle,
			});
		if (request.expectedSeq !== undefined && request.expectedSeq !== pauseSeq)
			return answered({ resumed: false, reason: "stale", ...idle });
		if (request.mode === "release" || inherited !== undefined) {
			// Only the parent's run Resume releases an inherited hold, so a child resumes no turn of its own.
			// A person's resume attends the session like their input does, so an unattended hold it frees stays freed.
			this._engineTurnHold.attend();
			this._engineTurnHold.release(
				holds.filter((hold) => hold.kind === "session_hold" || hold.kind === "unattended").map((hold) => hold.key),
				"resume_session",
			);
			return answered({ resumed: true, ...idle });
		}
		if (request.message !== undefined)
			this._heldInputs.hold({
				inputId: `resume-${request.effectId ?? crypto.randomUUID()}`,
				revision: 0,
				text: request.message,
			});
		const deliveredNotices = this._engineTurnHold.noticeCount;
		const deliveredHeldInputs = this._heldInputs.pending().length;
		// Payload-free notices (including goals) revalidate through their producer after release.
		// An interruption must not add a directive-only turn when that work has already completed.
		const resumeHeldTurn =
			this._stopHoldLive() &&
			(this._resumeCause() === "stop" || deliveredNotices === 0 || this._engineTurnHold.messages().length > 0);
		if (resumeHeldTurn || this._engineTurnHold.fences.length > 0 || deliveredHeldInputs > 0) {
			const { turnStarted, settled } = await this._resumeAfterStop(onQueued);
			return {
				answer: { resumed: true, pauseSeq, turnStarted, deliveredNotices, deliveredHeldInputs },
				settled,
			};
		}
		const settled = this._engineTurnRelease.resume(
			this._engineTurnHold,
			async (message, admit) => {
				const generation = this._userAbortGeneration;
				await this.waitForIdle();
				const claim = new DeferredTurnClaim();
				await this.sendCustomMessage(message, { triggerTurn: true }, claim, admit, undefined, onQueued);
				if ((await claim.disposition) !== "started") return false;
				await this.waitForIdle();
				if (generation !== this._userAbortGeneration) {
					this._engineTurnHold.invalidate();
					this._engineTurnHold.rejectInput();
					return false;
				}
				return true;
			},
			(sources) => this._extensionRunner.emitHeldWakesReleased(sources),
		);
		return {
			answer: {
				resumed: true,
				pauseSeq,
				turnStarted: deliveredNotices > 0,
				deliveredNotices,
				deliveredHeldInputs: 0,
			},
			settled,
		};
	}

	/**
	 * One turn after a Stop: held human input, then notices, then the directive. Resolves once that turn started (or
	 * once its send settled without one) and returns its settlement, which finishes the release only if the shared
	 * resume settlement delivered the turn.
	 */
	private async _resumeAfterStop(onQueued?: () => void): Promise<{ turnStarted: boolean; settled: Promise<void> }> {
		const resumeCause = this._resumeCause();
		const sources = this._engineTurnHold.releaseAll("resume_session");
		const { turnId, delivered } = await this._startResumeTurn(onQueued, resumeCause);
		const settled = (async () => {
			if (!(await delivered)) {
				this._engineTurnHold.rejectInput();
				return;
			}
			const remaining = this._engineTurnHold.finish();
			if (!this._engineTurnHold.held)
				await this._extensionRunner.emitHeldWakesReleased({ ...sources, ...remaining });
		})();
		return { turnStarted: turnId !== undefined, settled };
	}

	/**
	 * Settles once the latest resume turn's held input and notices were consumed, or the turn was not delivered
	 * (senpi#3811/#3864). Published when that resume turn begins, so a caller waits for consumption deterministically
	 * instead of counting ticks.
	 * @internal Not part of the RPC surface.
	 */
	resumeSettled(): Promise<void> {
		return this._resumeSettlement;
	}

	/** The resume turn both resume paths start; held input and notices are consumed only if no newer Stop aborted it. */
	private async _startResumeTurn(
		onQueued?: () => void,
		resumeCause: "stop" | "interrupted" = "stop",
	): ReturnType<typeof startRunResumeTurn> {
		const settlement = Promise.withResolvers<void>();
		this._resumeSettlement = settlement.promise;
		try {
			const generation = this._userAbortGeneration;
			let continues: ReadonlySet<string> = new Set();
			const prepared = new Map<string, HeldInput>();
			let heldInputs: HeldInput[];
			for (;;) {
				// A parent's pause can arrive during a read. Leave all input in custody for its run Resume.
				if (this._runHolds.inheritedOwner() !== undefined) {
					settlement.resolve();
					return { turnId: undefined, delivered: Promise.resolve(false) };
				}
				const commands = this._takeHeldCommands();
				continues = commands.continues;
				if (commands.run !== undefined) {
					await commands.run;
					continue;
				}
				const pending = this._heldInputs.pending().filter((input) => !continues.has(input.inputId));
				const unread = pending.filter((input) => prepared.get(input.inputId)?.entryId !== input.entryId);
				if (unread.length === 0) {
					heldInputs = pending.map((input) => prepared.get(input.inputId) ?? input);
					break;
				}
				await Promise.all(
					unread.map(async (input) => {
						prepared.set(input.inputId, { ...input, text: await this._preparedHeldText(input) });
					}),
				);
				// The hold is already released: include new or re-held input before sending, and omit withdrawals.
			}
			const started = await this._startResumeTurnWith(generation, continues, heldInputs, onQueued, resumeCause);
			started.delivered.then(
				() => settlement.resolve(),
				() => settlement.resolve(),
			);
			return started;
		} catch (error) {
			settlement.resolve();
			throw error;
		}
	}

	private _startResumeTurnWith(
		generation: number,
		continues: ReadonlySet<string>,
		heldInputs: HeldInput[],
		onQueued?: () => void,
		resumeCause: "stop" | "interrupted" = "stop",
	): ReturnType<typeof startRunResumeTurn> {
		return startRunResumeTurn({
			resumeCause,
			heldInputs: () => heldInputs,
			continueInputs: () => [...continues],
			heldWakes: () => this._engineTurnHold.messages(),
			send: (message) =>
				this.sendCustomMessage(message, { triggerTurn: true }, undefined, () => true, undefined, onQueued),
			turnStarted: (until) => this._nextTurnStart(until),
			idle: () => this.waitForIdle(),
			current: () => generation === this._userAbortGeneration,
			consume: (inputIds, sources) => {
				this._heldInputs.consume(inputIds);
				for (const source of sources) this._engineTurnHold.consume(source);
			},
			sendFailed: (error) => this._sessionLogger.warn("resume_turn_send_failed", { error: String(error) }),
		});
	}

	/** Human input kept while a run-owned hold blocks turns; idempotent by input id (senpi#3811). */
	holdInput(input: { inputId: string; revision: number; text: string; images?: ImageContent[] }): HoldInputResult {
		return this._heldInputs.hold(input);
	}

	withdrawHeldInput(inputId: string): boolean {
		return this._heldInputs.withdraw(inputId);
	}

	get pausedHeldInputCount(): number {
		return this._heldInputs.pending().length;
	}

	/** Before a human input releases a Stop: the hidden directive and held human input ride ahead of the wakes. */
	private _captureReleaseExtras(): void {
		if (!this._engineTurnHold.held || this._engineTurnHold.releasing || this._releaseExtras.length > 0) return;
		this._releaseExtrasGeneration = this._userAbortGeneration;
		if (this._stopHoldLive())
			this._releaseExtras.push({ role: "custom", ...stopResumeDirective(this._resumeCause()), timestamp: Date.now() });
		const { messages, commands } = this._takeHeldInputs();
		this._releaseExtras.push(...messages);
		// A later capture that finds no commands keeps the run an earlier one (a question answer's) still owes.
		if (commands !== undefined) this._heldCommandRun = commands;
	}

	/** The held-command run the last release started, for the person input it releases to await (senpi#3811). */
	private _takeHeldCommandRun(): Promise<void> | undefined {
		const run = this._heldCommandRun;
		this._heldCommandRun = undefined;
		return run;
	}

	/**
	 * Held input is prepared when delivered, not when held (senpi#3811). The held extension commands leave custody
	 * now and run in the order typed: a command that ran is delivered, so no later release runs it twice; the run
	 * reports a failure instead of rejecting. A manual-continue "." stays in custody: the delivering turn continues
	 * the work itself, so it is settled with that turn and stays held if the turn is not delivered.
	 */
	private _takeHeldCommands(): { run: Promise<void> | undefined; continues: ReadonlySet<string> } {
		const commands: HeldInput[] = [];
		const continues = new Set<string>();
		const hasMessages = this.agent.state.messages.length > 0;
		for (const input of this._heldInputs.pending()) {
			if (input.prepare !== true) continue;
			const hasImages = (input.images?.length ?? 0) > 0;
			if (this._isExtensionCommandText(input.text)) commands.push(input);
			else if (isManualContinueSubmission({ text: input.text, hasMessages, hasImages }))
				continues.add(input.inputId);
		}
		if (commands.length === 0) return { run: undefined, continues };
		this._heldInputs.consume(commands.map((input) => input.inputId));
		const run = (async () => {
			for (const input of commands) await this._tryExecuteExtensionCommand(input.text);
		})().catch((error: unknown) => this._sessionLogger.warn("held_command_failed", { error: String(error) }));
		return { run, continues };
	}

	/** A held person input's text as the model receives it: skills and prompt templates expanded. */
	private async _preparedHeldText(input: HeldInput): Promise<string> {
		if (input.prepare !== true) return input.text;
		return expandPromptTemplateWithMetadata(await this._expandSkillCommand(input.text), [...this.promptTemplates]).text;
	}

	private _takeHeldInputs(): { messages: Promise<CustomMessage>[]; commands: Promise<void> | undefined } {
		const { run, continues } = this._takeHeldCommands();
		const pending = this._heldInputs.pending();
		// Consumed at settlement only if the releasing turn was delivered; a "." rides that turn without a message.
		this._deliveredHeldInputIds.push(...pending.map((input) => input.inputId));
		const messages = pending
			.filter((input) => !continues.has(input.inputId))
			.map((input): Promise<CustomMessage> => {
				const timestamp = Date.now();
				const message = this._preparedHeldText(input).then(
					(text): CustomMessage => ({
						role: "custom",
						customType: HELD_INPUT_ENTRY,
						content: input.images === undefined ? text : [{ type: "text", text }, ...input.images],
						display: true,
						timestamp,
					}),
				);
				// The prompt that sends these awaits them and sees any failure; this branch only keeps an unsent one quiet.
				message.catch(() => {});
				return message;
			});
		return { messages, commands: run };
	}

	/**
	 * A superseded host generation draining a session nobody is attached to (senpi#3114): automatic turns wait as
	 * notices from here on, exactly as on an unattended reopen, so the running turn is the session's last on this
	 * host and it parks when that turn settles. A person's input or resume_session releases the hold.
	 */
	holdAutomaticTurns(): void {
		this._engineTurnHold.addHold("unattended");
	}

	/** A parent's Stop reaching this child (senpi#3811): hold every automatic turn until the parent's run Resume. */
	async pauseForRun(owner: {
		parentSessionId: string;
		parentPauseSeq: number;
		runRef: RunRef;
	}): Promise<InheritResult> {
		const result = this._runHolds.inherit(owner);
		if ("childSeq" in result) await this.abort();
		return result;
	}

	async resumeForRun(request: {
		parentSessionId: string;
		parentPauseSeq: number;
		childSeqCutoff: number;
	}): Promise<ReleaseInheritedResult & { turnId?: string }> {
		const released = this._runHolds.releaseInherited(request);
		if (!released.released || released.otherHoldLive || this._engineTurnHold.isHeld()) return released;
		const { turnId, delivered } = await this._startResumeTurn();
		delivered.catch((error: unknown) =>
			this._sessionLogger.warn("run_resume_settle_failed", { error: String(error) }),
		);
		return turnId === undefined ? released : { ...released, turnId };
	}

	private _pauseState(): { pauseSeq: number; holds: SessionHoldRecord[] } {
		const holds = this._engineTurnHold.holds.map(({ kind, key, data }) => ({
			kind,
			key,
			...(data === undefined ? {} : { data }),
		}));
		return { pauseSeq: this._engineTurnHold.currentPauseSeq, holds };
	}

	private _emitHoldChanged(event: { type: "session_paused" | "session_resumed"; pauseSeq: number }): void {
		const change = event.type === "session_paused" ? "paused" : "resumed";
		void this._extensionRunner
			.emit({ type: "session_hold_changed", change, ...this._pauseState(), pauseSeq: event.pauseSeq })
			.catch((error: unknown) => this._sessionLogger.warn("session_hold_changed_failed", { error: String(error) }));
	}

	private _nextTurnStart(until: Promise<void>): Promise<string | undefined> {
		return new Promise((resolve) => {
			const unsubscribe = this.subscribe((event) => {
				if (event.type !== "agent_start") return;
				unsubscribe();
				resolve(String(this.externalAdmission.turnEpoch));
			});
			void until.then(() => {
				unsubscribe();
				resolve(undefined);
			});
		});
	}

	noteAutomaticInput(text: string): boolean {
		const userHold = this._engineTurnHold.holds.some(
			(hold) =>
				(hold.kind === "session_hold" && hold.key !== "interrupted-run") || hold.kind === "inherited_hold",
		);
		if (!userHold) return false;
		const message: CustomMessage = {
			role: "custom",
			customType: "rpc-automatic-input",
			content: text,
			display: true,
			timestamp: Date.now(),
		};
		this._engineTurnHold.note(`rpc-input:${crypto.randomUUID()}`, message);
		return true;
	}

	private _stopAddedSince(observedPauseSeq: number): boolean {
		return this._engineTurnHold.holds.some(
			(hold) =>
				hold.kind === "session_hold" &&
				((hold.data as { localSeq?: number } | undefined)?.localSeq ?? 0) > observedPauseSeq,
		);
	}

	private _stopHoldLive(): boolean {
		return this._engineTurnHold.holds.some((hold) => hold.kind === "session_hold");
	}

	private _resumeCause(): "stop" | "interrupted" {
		const holds = this._engineTurnHold.holds;
		return holds.some((hold) => hold.kind === "session_hold" && hold.key === "interrupted-run") &&
			!holds.some((hold) => hold.kind === "session_hold" && hold.key !== "interrupted-run")
			? "interrupted"
			: "stop";
	}

	get pauseView(): {
		pauseSeq: number;
		records: { kind: string; key: string; runRef?: { kind: string; id: string }; parentSessionId?: string }[];
	} {
		return {
			pauseSeq: this._engineTurnHold.currentPauseSeq,
			records: this._engineTurnHold.holds.map(({ kind, key, data }) => {
				const value = (data ?? {}) as { runRef?: { kind: string; id: string }; parentSessionId?: string };
				return {
					kind,
					key,
					...(value.runRef === undefined ? {} : { runRef: value.runRef }),
					...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId }),
				};
			}),
		};
	}

	get runPaused(): boolean {
		return this._engineTurnHold.fences.length > 0;
	}

	get paused(): boolean {
		return this._engineTurnHold.isHeld();
	}

	private _createLifecycleBinding(): LifecycleSessionBinding {
		return new LifecycleSessionBinding(this, {
			append: (type, data) => {
				const startupBookkeeping =
					type === "session-lifecycle" &&
					typeof data === "object" &&
					data !== null &&
					"epoch" in data &&
					data.epoch === 0 &&
					"state" in data &&
					data.state === "done" &&
					"humanInputRevision" in data &&
					data.humanInputRevision === 0;
				const id = this.sessionManager.appendCustomEntry(type, data, { startupBookkeeping });
				this._emitEntryAppended(id);
				return id;
			},
			emit: (event) => this._emit(event),
			holdInterruptedRun: () => {
				this._holdForInterruptedRun({ triggerTurn: true });
			},
			factsFailed: (error) => this._sessionLogger.warn("lifecycle_goal_read_failed", { error: String(error) }),
		});
	}

	/** Reads the lifecycle; every fact that feeds it raises its own change edge, so a read never writes (senpi#3980). */
	get lifecycle() {
		return this._lifecycleBinding.controller.ledger.snapshot;
	}

	get workObligations() {
		return this._lifecycleBinding.controller.obligations;
	}

	get lifecycleApi(): LifecycleApi {
		return {
			obligations: this.workObligations,
			reportChild: (report) => this.reportChildLifecycle(report),
			markRunCompleted: ({ runId }) => this._lifecycleBinding.controller.markRunCompleted(runId),
		};
	}

	reportChildLifecycle(report: ChildLifecycleReport): void {
		this._lifecycleBinding.controller.reportChild(report);
	}

	requestSelfSettle() {
		return this._lifecycleBinding.controller.requestSelfSettle();
	}

	refreshLifecycle(): void {
		// Work aborted by dispose() still unwinds afterwards; its edges must not write to the released session file.
		if (this._disposed) return;
		this._lifecycleBinding.controller.recompute();
	}

	get pausedNoticeCount(): number {
		return this._engineTurnHold.noticeCount;
	}

	get holds() {
		return this._engineTurnHold.holds;
	}

	/**
	 * An automatic send that would start a turn while the previous run is interrupted waits for a person (senpi#4683):
	 * it joins the interrupted-run hold as a notice that Resume or the next message delivers. Refused as a turn it was
	 * lost, and each refusal counted as an engine turn until the no-work limit paused the session.
	 */
	private _holdForInterruptedRun(options: { triggerTurn?: boolean } | undefined): boolean {
		if (options?.triggerTurn !== true || this.isStreaming) return false;
		if (!this._lifecycleBinding.controller.requiresHumanContinuation) return false;
		if (this._engineTurnHold.getHold("interrupted-run") === undefined) {
			this._engineTurnHold.addHold("session_hold", { key: "interrupted-run" });
			this._extensionRunner
				.getUIContext()
				.notify(
					"Paused: the previous run was interrupted. Automatic updates are held until you send a message or /resume.",
					"warning",
				);
		}
		return true;
	}

	private _noteHeldWake(appMessage: CustomMessage, ticket: string | undefined): void {
		this._engineTurnHold.note(engineWakeSource(appMessage.customType), appMessage);
		if (!ticket) return;
		const noticeId = heldLifecycleNotice(this, ticket, appMessage.customType);
		if (noticeId) this.workObligations.held(ticket, noticeId);
	}

	/**
	 * The engine-turn bound's bookkeeping must never stop a turn: a session file that refuses the write (read-only,
	 * full disk) only loses the count, as the turn's own persistence reports the failure (senpi#2967).
	 */
	private _recordEngineTurnStart(customType: string): void {
		this._engineTurnPauseRecorded = false;
		this._engineTurnPauseNotified = false;
		this._engineTurnStarts.push({ at: Date.now(), toolUsed: false });
		try {
			this._emitEntryAppended(this.sessionManager.appendCustomEntry(ENGINE_TURN_START_ENTRY_TYPE, { customType }));
		} catch (error) {
			this._sessionLogger.warn("engine_turn_record_write_failed", {
				entry: ENGINE_TURN_START_ENTRY_TYPE,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * A refused engine turn still records its message and settles a cross-session delivery it carries. A delivery
	 * whose entry the file refuses leaves the context too: its sender redelivers it, and it must not appear twice.
	 */
	private _recordRefusedEngineTurnMessage(appMessage: CustomMessage): void {
		try {
			this._appendCustomMessage(appMessage);
			this.externalAdmission.observePersisted(appMessage);
		} catch (error) {
			if (deliveryIdOf(appMessage) !== undefined) {
				const index = this.agent.state.messages.lastIndexOf(appMessage);
				if (index >= 0) this.agent.state.messages.splice(index, 1);
			}
			this.externalAdmission.observeRefused(appMessage, error instanceof Error ? error.message : String(error));
			this._takePersistWatcher(appMessage)?.failed(error);
		}
	}

	/** Keeps this process's engine-turn record: a user message clears it, a tool call marks the running engine turn. */
	private _observeEngineTurnMessage(message: AgentMessage): void {
		if (
			message.role === "user" ||
			(message.role === "custom" && resetsEngineTurnHistory(message.customType, message.details))
		) {
			this._engineTurnStarts = [];
			this._engineResumeWindow = false;
			this._engineTurnPauseRecorded = false;
			this._engineTurnPauseNotified = false;
			return;
		}
		const running = this._engineTurnStarts.at(-1);
		if (
			running !== undefined &&
			message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall")
		) {
			running.toolUsed = true;
		}
	}

	/**
	 * An engine-originated turn (an extension's `sendMessage` with `triggerTurn`, from any source) that would
	 * exceed the engine-wide bound is not started: the message is still recorded, and the stop is recorded (best
	 * effort), emitted and shown, so a session file that refuses writes still pauses visibly (senpi#2967).
	 */
	private _stopEngineTurn(customType: string): boolean {
		if (isUserDirectedTurn(customType)) return false;
		const stop = engineTurnStop(
			this.sessionManager.reduceHistory(engineTurnHistory),
			Date.now(),
			{
				...this.settingsManager.getEngineTurnSettings(),
				maxPerResumeWindow: this._engineResumeWindow
					? this.settingsManager.getEngineTurnSettings().maxPerResumeWindow
					: 0,
			},
			this._engineTurnStarts,
		);
		if (stop === null) return false;
		const details = { customType, ...stop, at: Date.now() };
		if (!this._engineTurnPauseRecorded && !enginePauseSinceLastTurn(this.sessionManager.getBranch())) {
			this._engineTurnPauseRecorded = true;
			try {
				this._emitEntryAppended(
					this.sessionManager.appendCustomEntry(ENGINE_PAUSED_ENTRY_TYPE, {
						reason:
							stop.reason === "resume-window"
								? "cap-per-resume-window"
								: stop.reason === "per-user-input"
									? "cap-per-message"
									: "cap-per-minute",
						customType,
						count: stop.reason !== "tool-free-rate" ? stop.sinceUserInput : stop.toolFreeInWindow,
						at: details.at,
					}),
				);
			} catch (error) {
				this._sessionLogger.warn("engine_turn_record_write_failed", {
					entry: ENGINE_PAUSED_ENTRY_TYPE,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		try {
			this._emitEntryAppended(this.sessionManager.appendCustomEntry(ENGINE_TURN_LIMIT_ENTRY_TYPE, details));
		} catch (error) {
			this._sessionLogger.warn("engine_turn_record_write_failed", {
				entry: ENGINE_TURN_LIMIT_ENTRY_TYPE,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this._extensionRunner.emitBusEvent(ENGINE_TURN_LIMIT_EVENT, details);
		if (!this._engineTurnPauseNotified) {
			this._engineTurnPauseNotified = true;
			this._extensionRunner.getUIContext().notify(engineTurnLimitNotice(stop), "warning");
		}
		return true;
	}

	/** Environment context a new turn must carry: set when cwd or date differs from the latest one visible (senpi#2093). */
	private _pendingEnvironmentContextMessage(): CustomMessage<EnvironmentContext> | undefined {
		if (!this._environmentContextEnabled) return undefined;
		return environmentContextMessageIfChanged(this.agent.state.messages, resolveEnvironmentContext(this._cwd));
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.agent.state.messages.push(appMessage);
		const start = { type: "message_start" as const, message: appMessage };
		this._recoveryIdentity?.observe(start);
		const entryId = this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
			{ recoveryOwner: recoveryCarrier(start) },
		);
		this._emitEntryAppended(entryId);
		this._recordWrittenTicket(appMessage, entryId);
		this._takePersistWatcher(appMessage)?.persisted(entryId);
		this._incrementMessageRevision();
		this._emit(start);
		this._emit({ type: "message_end", message: appMessage });
	}

	private _flushPendingCustomMessages(): void {
		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const message of pending) this._appendCustomMessage(message);
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
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: {
			deliverAs?: "steer" | "followUp";
			expandPromptTemplates?: boolean;
		},
		deferredTurnClaim?: DeferredTurnClaim,
		inputOrigin: InputOrigin = "extension",
	): Promise<void> {
		if (this._engineTurnHold.held && inputOrigin !== "person") {
			await this.sendCustomMessage(
				{ customType: "extension-user-message", content, display: true },
				{ triggerTurn: true, deliverAs: options?.deliverAs },
				deferredTurnClaim,
			);
			return;
		}
		const bindingPromptReadiness = this._extensionBindingPromptReadiness;
		let resolveBindingPromptReadiness: (() => void) | undefined;
		if (bindingPromptReadiness) {
			const readiness = new Promise<void>((resolve) => {
				resolveBindingPromptReadiness = resolve;
			});
			bindingPromptReadiness.add(readiness);
		}
		// Normalize content to text string + optional images. A throw here (null or a
		// content array whose iterator/part getter throws) happens before the guarded
		// try below, so resolve the deferred-turn claim first to keep agent_idle reachable.
		let text: string;
		let images: ImageContent[] | undefined;
		let textBlocks: string[] | undefined;

		try {
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
				text = joinUserTextBlocks(textParts);
				if (textParts.length > 1) textBlocks = textParts;
				if (images.length === 0) images = undefined;
			}
		} catch (error) {
			deferredTurnClaim?.resolve("finished-without-start");
			resolveBindingPromptReadiness?.();
			throw error;
		}

		if (this._sizesOnlyStartup) {
			// Size inspection makes no model call (#3483): queue the input instead of starting a turn.
			try {
				await this._queueFollowUp(text, images, { textBlocks });
			} finally {
				deferredTurnClaim?.resolve("finished-without-start");
				resolveBindingPromptReadiness?.();
			}
			return;
		}
		// An extension binding invokes this method fire-and-forget. When it
		// arrives during session work, retain a barrier token after the prior work
		// settles so callers observing session idle cannot race its provider turn.
		const waitForExistingSessionWork = this._sessionWorkBarrier.hasActiveWork;
		let finishSessionWork: (() => void) | undefined;
		let disposition: PromptDisposition | undefined;
		try {
			await this.prompt(text, {
				expandPromptTemplates: options?.expandPromptTemplates ?? false,
				streamingBehavior: options?.deliverAs,
				images,
				textBlocks,
				source: "extension",
				inputOrigin,
				promptDisposition: (nextDisposition) => {
					disposition = nextDisposition;
					if (nextDisposition === "started") deferredTurnClaim?.resolve("started");
					else if (nextDisposition === "queued") deferredTurnClaim?.resolve("delegated");
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
					await this._queueSteer(text, images, {
						textBlocks,
						source: "extension",
						inputOrigin,
					});
				} else {
					await this._queueFollowUp(text, images, {
						textBlocks,
						source: "extension",
						inputOrigin,
					});
				}
			}
			throw error;
		} finally {
			// A path that neither started nor delegated a turn (handled, rejected,
			// admission failure, cancellation) resolves as finished-without-start.
			deferredTurnClaim?.resolve("finished-without-start");
			resolveBindingPromptReadiness?.();
			finishSessionWork?.();
		}
	}

	/** Reserve a global order for input temporarily owned outside the native queues. */
	reserveQueuedInputOrder(): number {
		this._nextQueuedInputOrder += 1;
		return this._nextQueuedInputOrder;
	}

	private _recordQueuedInput(
		text: string,
		mode: QueuedInput["mode"],
		options?: QueuedInputOptions,
		message?: AgentMessage,
		admittedQueuedId?: string,
	): string {
		const order = options?.enqueueOrder ?? this.reserveQueuedInputOrder();
		this._nextQueuedInputOrder = Math.max(this._nextQueuedInputOrder, order);
		const queuedId = admittedQueuedId ?? this._mintQueuedId();
		this._queuedInputOrder.push({
			text,
			mode,
			enqueueOrder: order,
			queuedId,
			revision: 1,
			...clientMessageIdentity(options),
		});
		if (message !== undefined) this._queuedMessages.set(queuedId, message);
		this._queuedInputAges.noteQueued(queuedId, Date.now());
		return queuedId;
	}

	/** Queued input that a whole turn started after and settled without delivering is overdue: say so (#4036). */
	private _warnQueuedInputOutlivingRun(agentEnd: AgentEvent | undefined): void {
		// A failed or aborted turn keeps queued input for the next prompt by design, so it proves nothing is stuck;
		// the next turn that ends normally still catches input that really is. A settle without an agent_end comes
		// only from such a turn (the prompt threw, a continuation failed, a retry was aborted in its backoff), and the
		// transcript would show an earlier turn's outcome instead, so it is never judged (senpi#4064).
		if (agentEnd?.type !== "agent_end") return;
		const lastAssistant = agentEnd.messages.findLast((message) => message.role === "assistant");
		if (lastAssistant?.role === "assistant" && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")) {
			return;
		}
		const stillQueued = this._queuedInputOrder.map((input) => input.queuedId);
		for (const { queuedId, ageMs } of this._queuedInputAges.takeOutlived(stillQueued, Date.now())) {
			const input = this._queuedInputOrder.find((candidate) => candidate.queuedId === queuedId);
			const message = this._queuedMessages.get(queuedId);
			this._sessionLogger.warn("queued_input_outlived_run", {
				queuedId,
				mode: input?.mode,
				ageMs,
				source: message === undefined ? undefined : this._userInputSources.get(message),
			});
		}
	}

	private _mintQueuedId(): string {
		this._nextQueuedId += 1;
		return `q_${this._nextQueuedId}`;
	}

	/** A queued input reached a turn: forget its record and remember its id as delivered. */
	private _removeQueuedInput(text: string, mode: QueuedInput["mode"], clientMessageId?: string): void {
		const index = this._queuedInputOrder.findIndex((message) =>
			clientMessageId === undefined
				? message.mode === mode && message.text === text
				: message.clientMessageId === clientMessageId,
		);
		if (index === -1) return;
		const [delivered] = this._queuedInputOrder.splice(index, 1);
		if (delivered === undefined) return;
		this._queuedMessages.delete(delivered.queuedId);
		this._deliveredQueuedIds.add(delivered.queuedId);
		if (this._deliveredQueuedIds.size > 256) {
			const oldest = this._deliveredQueuedIds.values().next().value;
			if (oldest !== undefined) this._deliveredQueuedIds.delete(oldest);
		}
	}

	/**
	 * Removes one queued input before it reaches a turn, from the visible lists and the native queue alike.
	 * An input already drained into a turn answers `already_delivered`.
	 */
	dequeueQueuedInput(queuedId: string, options?: QueuedInputChangeOptions): QueuedInputChange {
		return this._changeQueuedInput(queuedId, undefined, options?.expectedRevision);
	}

	/** Replaces the text of one queued input in place, keeping its order and identity, and bumps its revision. */
	editQueuedInput(queuedId: string, text: string, options?: QueuedInputChangeOptions): QueuedInputChange {
		return this._changeQueuedInput(queuedId, text, options?.expectedRevision);
	}

	/**
	 * Removes (`text` undefined) or edits one queued input. An input in durable custody (admitted with a client id)
	 * changes in its record first and in the native queue in the same gated step; any other input changes as
	 * `dequeueQueuedInput` / `editQueuedInput` do.
	 */
	async changeQueuedInput(
		queuedId: string,
		text: string | undefined,
		options?: QueuedInputChangeOptions & { readonly effectId?: string },
	): Promise<QueuedInputChange> {
		const clientMessageId = this._queuedInputOrder.find((input) => input.queuedId === queuedId)?.clientMessageId;
		const durable =
			clientMessageId === undefined
				? undefined
				: await this._pendingInputs.change(
						{
							clientMessageId,
							text,
							...(options?.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
							...(options?.effectId === undefined ? {} : { effectId: options.effectId }),
						},
						() => this._changeQueuedInput(queuedId, text, undefined),
					);
		return durable ?? this._changeQueuedInput(queuedId, text, options?.expectedRevision);
	}

	// Synchronous from the revision check to the change: nothing else on the session loop can land in between.
	private _changeQueuedInput(
		queuedId: string,
		nextText: string | undefined,
		expectedRevision: number | undefined,
	): QueuedInputChange {
		const index = this._queuedInputOrder.findIndex((input) => input.queuedId === queuedId);
		if (index === -1) return this._deliveredQueuedIds.has(queuedId) ? "already_delivered" : "not_found";
		const record = this._queuedInputOrder[index]!;
		const message = this._queuedMessages.get(queuedId);
		// Only user input is queued by id; anything else cannot be edited, and must not be removed by an edit.
		if (nextText !== undefined && message?.role !== "user") return "not_found";
		const deferred =
			record.mode === "steer"
				? this._postCompactionDeferredSteeringMessages
				: this._postCompactionDeferredFollowUpMessages;
		const nextMessage: AgentMessage | undefined =
			nextText === undefined || message?.role !== "user"
				? undefined
				: {
						...message,
						content: [
							...userTextContent(nextText),
							...(typeof message.content === "string"
								? []
								: message.content.filter((part) => part.type === "image")),
						],
					};
		const deferredIndex = message === undefined ? -1 : deferred.indexOf(message);
		if (expectedRevision !== undefined && record.revision !== expectedRevision) {
			// An input that already left the native queue answers already_delivered, as without a revision;
			// replacing the message with itself is a read-only probe of that queue.
			const queued =
				message !== undefined && (deferredIndex !== -1 || this.agent.replaceQueuedMessage(message, message));
			return queued ? "conflict" : "already_delivered";
		}
		const stillQueued =
			message !== undefined &&
			(deferredIndex !== -1 ||
				(nextMessage === undefined
					? this.agent.removeQueuedMessage(message)
					: this.agent.replaceQueuedMessage(message, nextMessage)));
		if (!stillQueued) return "already_delivered";
		if (deferredIndex !== -1) {
			if (nextMessage === undefined) deferred.splice(deferredIndex, 1);
			else deferred[deferredIndex] = nextMessage;
		}
		const texts = record.mode === "steer" ? this._steeringMessages : this._followUpMessages;
		const occurrence = this._queuedInputOrder
			.slice(0, index)
			.filter((input) => input.mode === record.mode && input.text === record.text).length;
		let seen = -1;
		const textIndex = texts.findIndex((text) => text === record.text && ++seen === occurrence);
		if (nextText === undefined || nextMessage === undefined) {
			if (textIndex !== -1) texts.splice(textIndex, 1);
			this._queuedInputOrder.splice(index, 1);
			this._queuedMessages.delete(queuedId);
		} else {
			if (textIndex !== -1) texts[textIndex] = nextText;
			this._queuedInputOrder[index] = { ...record, text: nextText, revision: record.revision + 1 };
			this._queuedMessages.set(queuedId, nextMessage);
		}
		this._emitQueueUpdate();
		return nextText === undefined ? "removed" : "edited";
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
		this._queuedMessages.clear();
		const recorded = this._pendingInputs.recordCleared(
			ordered.flatMap((input) => (input.clientMessageId === undefined ? [] : [input.clientMessageId])),
		);
		// A caller that acknowledges the clear awaits `recorded` and sees a failure; this logs it when nobody does.
		recorded.catch((error: unknown) => {
			this._sessionLogger.warn("pending_input_clear_unrecorded", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this._queueClearRecorded = recorded;
		this._postCompactionDeferredSteeringMessages = [];
		this._postCompactionDeferredFollowUpMessages = [];
		const clearedDeliveries = this._queuedDeliveryTickets();
		const clearedMessages = this.agent.peekQueuedMessages({ all: true });
		this.agent.clearAllQueues();
		this._releaseQueuedDeliveries(clearedDeliveries, "cleared");
		this._settleRemovedCarriers(clearedMessages);
		this.externalAdmission.dropQueued();
		this._emitQueueUpdate();
		const cleared = { steering, followUp } as ClearedQueue;
		Object.defineProperty(cleared, "ordered", {
			value: ordered,
			enumerable: false,
		});
		return cleared;
	}

	/**
	 * Settles once the last `clearQueue` is recorded in the pending-input journal. `clearQueue` stays synchronous;
	 * a caller that acknowledges the clear (RPC `clear_queue`) awaits this first so its answer is durable.
	 */
	whenQueueClearRecorded(): Promise<void> {
		return this._queueClearRecorded;
	}

	/**
	 * Whether a person's input is waiting in the queue: a TUI submit, an RPC client prompt/steer/follow_up or an
	 * answered question, tagged when it was enqueued. Decided from the entries actually queued now, so an input
	 * that was delivered, dequeued or cleared no longer counts. Extension and engine sends are never a person's.
	 */
	get hasQueuedPersonInput(): boolean {
		for (const id of this._personQueuedIds) {
			if (!this._queuedInputOrder.some((input) => input.queuedId === id)) this._personQueuedIds.delete(id);
		}
		return this._personQueuedIds.size > 0;
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

	/** The pending inputs in durable custody, and an explicit outcome for each id the caller already knows. */
	getPendingInputs(knownClientMessageIds?: readonly string[]): Promise<PendingInputSnapshot> {
		return this._pendingInputs.snapshot(knownClientMessageIds);
	}

	getQueuedInputs(): readonly QueuedInput[] {
		return [...this._queuedInputOrder].sort((left, right) => left.enqueueOrder - right.enqueueOrder);
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/** A user Stop: hold automatic turns until human input or resume_session, then stop the running turn (senpi#3811). */
	async stop(): Promise<void> {
		this._runHolds.stamp();
		this.refreshLifecycle();
		this._stopInterrupt = { pauseSeq: this._engineTurnHold.currentPauseSeq, at: new Date().toISOString() };
		try {
			await this.abort();
		} finally {
			this._stopInterrupt = undefined;
		}
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(options?: { readonly cause?: AgentAbortCause }): Promise<void> {
		// The first named cause wins until the `agent_end` it explains is emitted (or a new run starts):
		// a plain abort racing a replacement's teardown never erases the replacement's cause.
		if (options?.cause !== undefined && this._abortCause === undefined) this._abortCause = options.cause;
		await this._abortWithProvenance();
	}

	private async _abortWithProvenance(): Promise<void> {
		// Streaming aborts are carried by agent_end provenance; only gaps need session_abort.
		const wasMidRun = this.isStreaming && this._retryAbortController === undefined;
		const hadRetryBackoff = this._retryAbortController !== undefined;
		const hasPendingTriggerTurnAdmission =
			this._pendingCustomTurnHeaders > 0 || this._triggerTurnAdmissionAbortGeneration === this._userAbortGeneration;
		const hadCompactionOrPending =
			!this.isStreaming && (this.isCompacting || this.pendingMessageCount > 0 || hasPendingTriggerTurnAdmission);
		const hadClearedQueues = this._hadClearedQueuedMessages;
		const joinedAgentEndBoundary = this._abortProvenance.hasOpenAgentEndBoundary;
		this._hadClearedQueuedMessages = false;
		const shouldEmitAbort =
			!joinedAgentEndBoundary && !wasMidRun && (hadRetryBackoff || hadCompactionOrPending || hadClearedQueues);
		this.abortCompaction();
		if (hasPendingTriggerTurnAdmission) this._recordUserAbort();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		await this._abortActiveAgentAndRetry("user");
		const releaseStranded = () => this._releaseQueuedDeliveries(this._queuedDeliveryTickets(), "aborted");
		if (this.isIdle) releaseStranded();
		else
			this.waitForIdle().then(releaseStranded, (error: unknown) => {
				this._sessionLogger.warn("abort_delivery_release_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		// An Esc that joined an open agent_end boundary returns at once: a boundary handler that holds the run is still
		// released after the grace (senpi#3650), without making abort() itself wait for it.
		if (!this.isIdle) {
			this._waitForIdleAfterAbort().catch((error: unknown) => {
				this._sessionLogger.warn("abort_release_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
		if (!shouldEmitAbort) return;
		try {
			await this._emitSessionAbort();
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
	async setModel(
		model: Model<any>,
		origin: ModelChangeOrigin = SDK_MODEL_CHANGE,
	): Promise<SystemPromptChangeEvent | undefined> {
		return this._setModel(model, true, origin);
	}

	assertModelUsable(
		model: Model<Api> | undefined = this.model,
		liveContextTokens = 0,
		options?: { includeSpeculationLead?: boolean; admission?: ModelUsabilityAdmission },
	): void {
		if (!model || model.contextWindow <= 0) return;
		const projection = projectModelUsabilityBudget({
			model,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			liveContextTokens,
			compaction: this._getCompactionSettings(),
			includeSpeculationLead: options?.includeSpeculationLead,
			admission: options?.admission,
		});
		if (!projection.usable) throw new ModelUsabilityBudgetError(projection);
	}

	/** Admit an oversized restored transcript so the normal pre-provider compaction can run. */
	/** The switch waiting for the next send to compact for it, if any (#1873). */
	get pendingModelSwitch(): PendingModelSwitch | undefined {
		return this._pendingModelSwitch;
	}

	/**
	 * A switch the target cannot hold yet but one compaction would fix. Refusing it
	 * discards what the user asked for; committing it strands the session on a model
	 * that cannot answer. Holding it does neither: nothing durable is written until
	 * the next send has reduced the transcript and the switch actually applies.
	 */
	private _projectSwitchDeferral(
		model: Model<Api>,
		liveContextTokens: number,
	): ModelUsabilityBudgetProjection | undefined {
		if (model.contextWindow <= 0) return undefined;
		const compaction = this._getCompactionSettings();
		if (!compaction.enabled) return undefined;
		if (this._modelSwitchAdmission() !== "switch") return undefined;
		const projection = projectModelUsabilityBudget({
			model,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			liveContextTokens,
			compaction,
			includeSpeculationLead: false,
			admission: "switch",
		});
		return projection.verdict === "fits-after-compaction" ? projection : undefined;
	}

	private _admitSwitchCompactionRequired(
		model: Model<Api>,
		projection: ModelUsabilityBudgetProjection,
		persistDefault: boolean,
		origin: ModelChangeOrigin,
	): void {
		const pending = createPendingModelSwitch({ model, projection, persistDefault, origin });
		this._clearPendingModelSwitch();
		this._pendingModelSwitch = pending;
		this._emit({
			type: "model_change_pending",
			model,
			contextWindow: projection.contextWindow,
			liveContextTokens: projection.liveContextTokens,
			requiredTokens: projection.requiredTokens,
			shortfallTokens: projection.shortfallTokens,
			notice: pending.notice,
		});
	}

	private _clearPendingModelSwitch(error?: ModelUsabilityBudgetError): void {
		const pending = this._pendingModelSwitch;
		this._pendingModelSwitch = undefined;
		if (pending !== undefined) {
			this._emit({
				type: "model_change_cancelled",
				origin: pending.origin,
				reason: error === undefined ? "superseded" : "context-budget",
				...(error === undefined ? {} : { detail: error.message }),
			});
		}
	}

	/**
	 * Fit a fallback rung by reducing the transcript without a provider request
	 * (#1873). Summarizing is not available here: the model being fallen back from
	 * has usually just failed, and the rung itself cannot hold the transcript, so
	 * the deterministic slice is the only reduction that can run. The recorded
	 * transcript stays intact in the session file.
	 */
	private _reduceForSwitchTarget(model: Model<Api>, liveContextTokens: number): number {
		if (!this._getCompactionSettings().enabled) return liveContextTokens;
		const projection = this._projectSwitchFit(model);
		if (projection.usable || projection.verdict !== "fits-after-compaction") return liveContextTokens;
		const plan = planResumeSlice({ entries: this.sessionManager.getBranch(), projection });
		if (!plan) return liveContextTokens;
		this.applyResumeSlice(plan);
		return this._projectSwitchFit(model).liveContextTokens;
	}

	private _projectSwitchFit(model: Model<Api>): ModelUsabilityBudgetProjection {
		// Measured per message rather than through the context estimate: a retained
		// turn keeps the usage it reported before the reduction, so a usage-derived
		// total cannot observe the compaction that just ran (the sdk.ts convention).
		const liveContextTokens = filterContextExcludedMessages(
			this.sessionManager.buildSessionContext().messages,
		).reduce((total, message) => total + estimateTokens(message), 0);
		return projectModelUsabilityBudget({
			model,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			liveContextTokens,
			compaction: this._getCompactionSettings(),
			includeSpeculationLead: false,
			admission: "switch",
		});
	}

	/**
	 * Repair and apply a held switch, in the one order that works: the model that
	 * can still hold the transcript writes the summary, the reduction aims at the
	 * window the transcript must end up inside, and only a transcript that actually
	 * fits is allowed to carry the switch. The deterministic slice is the floor when
	 * summarization did not get there, so a repairable switch cannot strand itself.
	 */
	private async _applyPendingModelSwitch(
		assistantMessage: AssistantMessage | undefined,
		skipAbortedCheck: boolean,
		inlineReason: "pre_prompt" | "threshold",
	): Promise<boolean> {
		const pending = this._pendingModelSwitch;
		if (pending === undefined) return false;
		if (!this.model) throw new RequiredCompactionError();

		await this._runPrePromptCompaction(
			assistantMessage,
			skipAbortedCheck,
			inlineReason,
			false,
			false,
			pendingSwitchKeepRecentTokens(pending.projection),
		);

		let projection = this._projectSwitchFit(pending.model);
		if (!projection.usable) {
			const plan = planResumeSlice({ entries: this.sessionManager.getBranch(), projection });
			if (plan) {
				this.applyResumeSlice(plan);
				projection = this._projectSwitchFit(pending.model);
			}
		}

		if (!projection.usable) {
			const error = new ModelUsabilityBudgetError(projection);
			this._clearPendingModelSwitch(error);
			this._recordRejectedModelChange(pending.model, error);
			throw error;
		}
		this._pendingModelSwitch = undefined;

		try {
			await this._switchActiveModel(pending.model, {
				persistDefault: pending.persistDefault,
				appendSessionEntry: true,
				emitModelSelect: true,
				modelSelectSource: "set",
				invalidateCompaction: true,
				allowDeferral: false,
				admittedLiveContextTokens: projection.liveContextTokens,
				origin: heldSwitchOrigin(pending.origin),
			});
		} catch (error) {
			this._emit({
				type: "model_change_cancelled",
				origin: pending.origin,
				reason: error instanceof ModelUsabilityBudgetError ? "context-budget" : "error",
				detail: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		return true;
	}

	/** Whether a recorded resume requirement still blocks: the current context does not fit the current model. */
	private _resumeRequirementStillBlocks(
		model: Model<any>,
		settings: ReturnType<SettingsManager["getCompactionSettings"]>,
	): boolean {
		// Kept assistant usage predates an accepted checkpoint. The projection
		// estimates its summary and suffix until a fresh provider response supersedes it.
		const currentContext = estimateProjectedContextTokens(
			this.sessionManager.buildSessionProjection(),
			this.sessionManager.getBranch(),
		).tokens;
		return !projectModelUsabilityBudget({
			model,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			liveContextTokens: currentContext,
			compaction: settings,
			includeSpeculationLead: false,
			admission: "resume",
		}).usable;
	}

	/** Any committed compaction, manual /compact included, retires a resume requirement the context now satisfies. */
	private _clearResumeCompactionRequirementIfFits(): void {
		const model = this.model;
		if (this._resumeCompactionRequirement === undefined || !model) return;
		if (!this._resumeRequirementStillBlocks(model, this._getCompactionSettings(model)))
			this._resumeCompactionRequirement = undefined;
	}

	admitResumeCompactionRequired(projection: ModelUsabilityBudgetProjection): void {
		this._resumeCompactionRequirement = createResumeCompactionRequirement(projection);
	}

	/** Reduce an over-window restored context deterministically while the recorded transcript stays intact. */
	applyResumeSlice(plan: ResumeSlicePlan): void {
		this.sessionManager.appendCompaction(plan.summary, plan.firstKeptEntryId, plan.tokensBefore, {
			schema: RESUME_SLICE_SCHEMA,
			origin: RESUME_SLICE_ORIGIN,
		});
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		this._resumeSlice = plan;
		this._sessionLogger.info("resume_context_reduced", {
			count: plan.droppedEntries,
			tokensBefore: plan.tokensBefore,
			tokensAfter: plan.tokensAfter,
		});
		this._emit(this._resumeSliceEvent(plan));
	}

	private _resumeSliceEvent(plan: ResumeSlicePlan): AgentSessionEvent {
		return {
			type: "resume_context_reduced",
			tokensBefore: plan.tokensBefore,
			tokensAfter: plan.tokensAfter,
			droppedEntries: plan.droppedEntries,
			notice: resumeSliceNotice(plan),
		};
	}

	private _getDownswitchLiveContextTokens(model: Model<Api>): number {
		const currentModel = this.model;
		if (!currentModel) return 0;
		const compaction = this._getCompactionSettings();
		const currentBudget = projectModelUsabilityBudget({
			model: currentModel,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			compaction,
		});
		const targetBudget = projectModelUsabilityBudget({
			model,
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools,
			compaction,
		});
		const currentUsableContext = currentBudget.contextWindow - currentBudget.requiredTokens;
		const targetUsableContext = targetBudget.contextWindow - targetBudget.requiredTokens;
		if (targetUsableContext >= currentUsableContext) return 0;
		const fixedPrefixTokens = currentBudget.systemPromptTokens + currentBudget.activeToolSchemaTokens;
		return Math.max(0, (this.getContextUsage()?.tokens ?? 0) - fixedPrefixTokens);
	}

	/**
	 * Set the model for this session without changing the global model defaults.
	 * The selection is still persisted in this session's history.
	 */
	async setSessionModel(
		model: Model<Api>,
		origin: ModelChangeOrigin = SDK_MODEL_CHANGE,
	): Promise<SystemPromptChangeEvent | undefined> {
		return this._setModel(model, false, origin);
	}

	/**
	 * #1526: every switch guard rejects before `_switchActiveModel` appends its
	 * `model_change`, so a refused switch used to leave no entry, no event, and
	 * no log line - indistinguishable from a switch the user never attempted.
	 * Record the refusal, then rethrow the original error unchanged.
	 */
	private _recordRejectedModelChange(model: Model<Api>, error: unknown): void {
		const budget = error instanceof ModelUsabilityBudgetError ? error.projection : undefined;
		const detail = error instanceof Error ? error.message : String(error);
		const reason = budget ? "context-budget" : "auth";
		const numbers = budget
			? {
					contextWindow: budget.contextWindow,
					liveContextTokens: budget.liveContextTokens,
					requiredTokens: budget.requiredTokens,
					shortfallTokens: budget.shortfallTokens,
					safetyMarginProfile: budget.safetyMarginProfile,
				}
			: {};
		this.sessionManager.appendModelChangeRejected({
			provider: model.provider,
			modelId: model.id,
			reason,
			detail,
			...numbers,
		});
		this._emit({ type: "model_change_rejected", model, reason, detail, ...numbers });
	}

	/**
	 * The admission only selects wording, and the switch wording's remedy
	 * ("Compact the session, ...") is executable only when there is context to
	 * compact. `_setModel` is also reachable from `session_start` (the
	 * `recommended-models` builtin switches the model there), so derive the
	 * admission from the branch instead of hardcoding a switch: with conversation
	 * context this is a switch, on an empty session it is still a cold start.
	 */
	private _modelSwitchAdmission(): ModelUsabilityAdmission {
		return this.sessionManager.hasContextMessages() ? "switch" : "start";
	}

	/**
	 * The single guard seam for a model switch (#1526): every site that can
	 * refuse a switch - the `_setModel` pre-flight, the post-`model_select`
	 * revalidation in `_switchActiveModel`, and both cycle guards - records the
	 * refusal and rethrows the original error unchanged, so no refusal is
	 * observable on one path and invisible on its sibling.
	 */
	private _assertModelUsableForSwitch(model: Model<Api>, liveContextTokens: number): void {
		const admission = this._modelSwitchAdmission();
		try {
			// #1873: a live switch only has to fit the next single request. Speculation
			// runs after the switch is admitted and cannot shrink a transcript it has not
			// been admitted to yet - the reasoning #1339 applied to resume, which this
			// extends to the switch path. The cold-start floor (`start`) keeps charging
			// the lead, because there it is a property of the model, not of a transcript.
			this.assertModelUsable(model, liveContextTokens, {
				admission,
				includeSpeculationLead: admission === "start",
			});
		} catch (error) {
			this._recordRejectedModelChange(model, error);
			throw error;
		}
	}

	private async _setModel(
		model: Model<Api>,
		updateGlobalDefaults: boolean,
		origin: ModelChangeOrigin,
	): Promise<SystemPromptChangeEvent | undefined> {
		const liveContextTokens = this._getDownswitchLiveContextTokens(model);
		const deferral = this._projectSwitchDeferral(model, liveContextTokens);
		if (deferral === undefined) {
			this._assertModelUsableForSwitch(model, liveContextTokens);
		}
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			const error = new ModelSwitchAuthError(model.provider, model.id);
			this._recordRejectedModelChange(model, error);
			throw error;
		}
		// Auth is the last check that can refuse outright, so the switch is only held
		// once it is otherwise good: a pending switch to a model with no key would
		// surface its failure a whole message later.
		if (deferral !== undefined) {
			this._admitSwitchCompactionRequired(model, deferral, updateGlobalDefaults, origin);
			return undefined;
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
			origin,
		});
	}

	private async _maybeRestoreFallbackPrimary(boundary: "turn" | "continuation" = "turn"): Promise<void> {
		try {
			await this._retryFallback.maybeRestorePrimary(
				this.settingsManager.getRetryFallbackSettings().revertPolicy,
				boundary,
			);
			await this._retryFallback.rerouteAroundOpenCircuit();
		} catch (error) {
			this._retryFallback.clear();
			console.error("fallback revert failed; cleared fallback state", error);
		}
	}

	/**
	 * A senpi-owned compaction just rewrote the conversation context: release any
	 * refusal-caused fallback pin (the "same context refuses again" assumption no
	 * longer holds) and, while no run is active, eagerly re-attempt the original
	 * model through the existing revert gate. Billing-caused pins never release.
	 */
	private async _onCompactionContextChanged(): Promise<void> {
		const released = this._retryFallback.notifyCompactionApplied();
		if (released && !this.isStreaming) await this._maybeRestoreFallbackPrimary("turn");
	}

	private async _switchActiveModel(
		model: Model<Api>,
		opts: {
			persistDefault: boolean;
			appendSessionEntry: boolean;
			entryReason?: "fallback" | "fallback-revert";
			/** Recorded on the `model_change` entry, the event and the session log (senpi#2870). */
			origin: ModelChangeOrigin;
			emitModelSelect: boolean;
			modelSelectSource: ModelSelectSource;
			invalidateCompaction: boolean;
			ephemeralThinkingLevel?: ThinkingLevel;
			/**
			 * Off for the paths that must settle now (#1873): applying a held switch,
			 * where re-holding would defer the same switch forever, and the fallback
			 * lanes, whose retry is the next request and has nothing to wait for.
			 */
			allowDeferral?: boolean;
			/**
			 * Reduce the transcript in place so this switch can settle now (#1873). Used
			 * by the fallback lanes: a rung that cannot hold the conversation is repaired
			 * rather than rejected, because rejecting it fails a chain whose rungs are all
			 * smaller than the model that just failed.
			 */
			repairWithSlice?: boolean;
			/**
			 * The context a held switch was already admitted with, measured per message
			 * after its reduction (#3828). The usage-derived estimate still reports the
			 * pre-slice size of a kept turn, so re-measuring here refused a switch the
			 * reduction had just made fit.
			 */
			admittedLiveContextTokens?: number;
		},
	): Promise<SystemPromptChangeEvent | undefined> {
		const previousModel = this.model;
		const duringTurn = this.isStreaming;
		if (
			opts.invalidateCompaction &&
			(this._modelSelectionChangesContext(previousModel, model) ||
				previousModel?.provider !== model.provider ||
				previousModel?.id !== model.id)
		) {
			this._invalidateCompactionForModelSelection();
		}
		const thinking = this._getThinkingForModelSwitch(model, opts.ephemeralThinkingLevel, undefined, true);
		const liveContextTokens = this._getDownswitchLiveContextTokens(model);
		// Snapshot before any mutation: the baseline reset below used to run first, so the
		// "previous" value captured the already-cleared one and a refused switch restored
		// `undefined` instead of the baseline the session came in with.
		const previousReasoningBaseline = this.agent.state.reasoningBaseline;
		const previousAbortServerSideFallback = this.agent.abortServerSideFallback;
		this.agent.state.model = model;
		if (!supportsConfigurationUpdate(model)) {
			this.agent.state.reasoningBaseline = undefined;
		}
		const scopedMatch = this._scopedModels.find((sm) => modelsAreEqual(sm.model, model));
		const previousTier = this._currentServiceTier;
		const previousFastMode = this.isFastModeActive();
		const previousThinkingLevel = this.agent.state.thinkingLevel;
		const previousThinkingSelection = this.agent.state.thinkingSelection;
		const previousThinkingLevelSource = this._thinkingLevelSource;
		this.agent.abortServerSideFallback =
			this.settingsManager.getAbortServerSideFallback() && this._retryFallback.hasConfiguredChain();
		this._currentServiceTier = this._resolveServiceTier(model, scopedMatch?.serviceTier);

		if (opts.ephemeralThinkingLevel !== undefined) {
			this._applyEphemeralThinkingLevel(thinking.level);
		} else {
			this._setThinkingLevel(thinking.level, false, thinking.selection, opts.origin);
		}
		this._thinkingLevelSource = thinking.source;

		this._emitHighReasoningWarningIfNeeded();
		const previousSystemPrompt = this.agent.state.systemPrompt;
		try {
			const systemPromptChange = opts.emitModelSelect
				? await this._emitModelSelect(model, previousModel, opts.modelSelectSource)
				: undefined;
			const deferral =
				opts.allowDeferral === false ? undefined : this._projectSwitchDeferral(model, liveContextTokens);
			if (deferral !== undefined) {
				// Roll the in-memory selection back: the switch is held, not applied, so
				// nothing may observe the target as active until the next send repairs it.
				if (previousModel) this.agent.state.model = previousModel;
				this.agent.state.systemPrompt = previousSystemPrompt;
				this.agent.state.thinkingLevel = previousThinkingLevel;
				this.agent.state.thinkingSelection = previousThinkingSelection;
				this._thinkingLevelSource = previousThinkingLevelSource;
				this.agent.state.reasoningBaseline = previousReasoningBaseline;
				this.agent.abortServerSideFallback = previousAbortServerSideFallback;
				this._currentServiceTier = previousTier;
				this._admitSwitchCompactionRequired(model, deferral, opts.persistDefault, opts.origin);
				return undefined;
			}
			const admittedLiveContextTokens =
				opts.admittedLiveContextTokens ??
				(opts.repairWithSlice ? this._reduceForSwitchTarget(model, liveContextTokens) : liveContextTokens);
			this._assertModelUsableForSwitch(model, admittedLiveContextTokens);
			if (opts.appendSessionEntry) {
				this.sessionManager.appendModelChange(
					model.provider,
					model.id,
					opts.entryReason,
					previousModel?.provider,
					previousModel?.id,
					{ origin: opts.origin, duringTurn },
				);
			}
			if (opts.persistDefault) this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._sessionLogger.info(
				"model_change",
				modelChangeLogFields({
					origin: opts.origin,
					from: previousModel,
					to: model,
					duringTurn,
					persistDefault: opts.persistDefault,
				}),
			);
			// A switch that actually landed supersedes anything still being held (#1873).
			// Without this a held switch survives its own resolution - an explicit
			// /compact followed by a manual retry applies the switch here, and the stale
			// hold would compact and re-switch again on the next message.
			this._clearPendingModelSwitch();
			// Emit only after all admission hooks have accepted the candidate.
			this._emit({
				type: "model_changed",
				model,
				thinkingLevel: this.thinkingLevel,
				source: opts.modelSelectSource,
				origin: opts.origin,
				...(previousModel === undefined ? {} : { previousModel }),
				duringTurn,
			});
			this._emitServiceTierChangeIfNeeded(previousTier, previousFastMode);
			return systemPromptChange;
		} catch (error) {
			if (previousModel) this.agent.state.model = previousModel;
			else delete (this.agent.state as { model?: Model<Api> }).model;
			this.agent.state.systemPrompt = previousSystemPrompt;
			this.agent.state.thinkingLevel = previousThinkingLevel;
			this.agent.state.thinkingSelection = previousThinkingSelection;
			this._thinkingLevelSource = previousThinkingLevelSource;
			this.agent.state.reasoningBaseline = previousReasoningBaseline;
			this.agent.abortServerSideFallback = previousAbortServerSideFallback;
			this._currentServiceTier = previousTier;
			throw error;
		}
	}

	private _applyEphemeralThinkingLevel(level: ThinkingLevel): void {
		const previousLevel = this.agent.state.thinkingLevel;
		this.agent.state.thinkingLevel = level;
		this.agent.state.thinkingSelection = undefined;
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
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: { readonly persistDefault?: boolean; readonly origin?: ModelChangeOrigin } = {},
	): Promise<ModelCycleResult | undefined> {
		const favoriteModels = this._getCurrentFavoriteModels();
		if (favoriteModels.length > 0) {
			return this._cycleFavoriteModel(direction, favoriteModels, {
				persistDefault: options.persistDefault ?? true,
				origin: options.origin ?? { source: "cycle" },
			});
		}
		return undefined;
	}

	private async _cycleFavoriteModel(
		direction: "forward" | "backward",
		favoriteModels: SessionModelEntry[],
		cycle: { readonly persistDefault: boolean; readonly origin: ModelChangeOrigin },
	): Promise<ModelCycleResult | undefined> {
		if (favoriteModels.length <= 1) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const currentIndex = favoriteModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		let nextIndex: number;
		if (currentIndex === -1) {
			nextIndex = direction === "forward" ? 0 : favoriteModels.length - 1;
		} else {
			const len = favoriteModels.length;
			nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		}
		const favoriteCount = favoriteModels.length;
		const step = direction === "forward" ? 1 : -1;
		let selectedIndex: number | undefined;
		const skippedModels: Model<any>[] = [];
		for (let offset = 0; offset < favoriteCount; offset++) {
			const candidate = favoriteModels[(nextIndex + step * offset + favoriteCount) % favoriteCount];
			if (modelsAreEqual(candidate.model, currentModel)) continue;
			const admission = this._modelChangeWouldExhaustContext(candidate.model);
			if (admission) {
				skippedModels.push(candidate.model);
				this._emit({
					type: "model_change_skipped",
					model: candidate.model,
					contextWindow: candidate.model.contextWindow,
					liveContextTokens: admission.liveContextTokens,
					requiredTokens: admission.requiredTokens,
					shortfallTokens: admission.shortfallTokens,
					safetyMarginProfile: admission.safetyMarginProfile,
					direction,
				});
				continue;
			}
			selectedIndex = (nextIndex + step * offset + favoriteCount) % favoriteCount;
			break;
		}
		if (selectedIndex === undefined) {
			// Every candidate was inadmissible. Skipping only makes sense when there was somewhere else
			// to skip TO: with more than one alternative the cycle reports the skipped list and stays put
			// (#1378's convenience). With a single alternative the user asked for THAT model, so the
			// documented ModelUsabilityBudgetError still surfaces instead of a silent no-op.
			const alternatives = favoriteModels.filter((entry) => !modelsAreEqual(entry.model, currentModel));
			const onlyAlternative = alternatives.length === 1 ? alternatives[0] : undefined;
			if (onlyAlternative) {
				const onlyLiveContextTokens = this._getDownswitchLiveContextTokens(onlyAlternative.model);
				const onlyDeferral = this._projectSwitchDeferral(onlyAlternative.model, onlyLiveContextTokens);
				if (onlyDeferral !== undefined) {
					this._admitSwitchCompactionRequired(
						onlyAlternative.model,
						onlyDeferral,
						cycle.persistDefault,
						cycle.origin,
					);
				} else {
					this._assertModelUsableForSwitch(onlyAlternative.model, onlyLiveContextTokens);
				}
			}
			return {
				model: currentModel,
				thinkingLevel: this.thinkingLevel,
				isScoped: true,
				skippedModels,
			};
		}
		const next = favoriteModels[selectedIndex];
		const liveContextTokens = this._getDownswitchLiveContextTokens(next.model);
		// #1873: the cycle lands on a candidate one compaction would admit instead of
		// refusing it. Nothing is mutated yet, so holding here needs no rollback.
		const cycleDeferral = this._projectSwitchDeferral(next.model, liveContextTokens);
		if (cycleDeferral !== undefined) {
			this._admitSwitchCompactionRequired(next.model, cycleDeferral, cycle.persistDefault, cycle.origin);
			return {
				model: currentModel,
				thinkingLevel: this.thinkingLevel,
				isScoped: true,
				skippedModels,
			};
		}
		this._assertModelUsableForSwitch(next.model, liveContextTokens);
		const invalidatesCompaction =
			this._modelSelectionChangesContext(currentModel, next.model) ||
			currentModel?.provider !== next.model.provider ||
			currentModel?.id !== next.model.id;
		if (invalidatesCompaction) {
			this._invalidateCompactionForModelSelection();
		}
		this._probeBackScheduler.cancel("manual-model-change");
		this._retryFallback.clearForManualModelChange(next.model);
		const thinking = this._getThinkingForModelSwitch(next.model, next.thinkingLevel, next.thinkingSelection);

		this.agent.state.model = next.model;
		const previousTier = this._currentServiceTier;
		const previousFastMode = this.isFastModeActive();
		this._currentServiceTier = this._resolveServiceTier(next.model, next.serviceTier);

		// Apply thinking level and provenance from the favorite projection or remembered preference.
		this._setThinkingLevel(thinking.level, false, thinking.selection, cycle.origin);
		this._thinkingLevelSource = thinking.source;

		const previousSystemPrompt = this.agent.state.systemPrompt;
		try {
			const systemPromptChange = await this._emitModelSelect(next.model, currentModel, "cycle");
			// #1526: the `model_select` hook may have grown the system prompt, so the
			// switch is not decided yet. Nothing durable - no `model_change`, no global
			// default - may be written before this guard accepts, or a refused cycle
			// would resume on a model that never ran (the ordering `_switchActiveModel`
			// already uses).
			// #1873: a prompt that only grew past the budget is held, not refused; the
			// in-memory selection rolls back exactly as the catch below would.
			const postHookDeferral = this._projectSwitchDeferral(next.model, liveContextTokens);
			if (postHookDeferral !== undefined) {
				if (currentModel) this.agent.state.model = currentModel;
				this.agent.state.systemPrompt = previousSystemPrompt;
				this._currentServiceTier = previousTier;
				this._admitSwitchCompactionRequired(next.model, postHookDeferral, cycle.persistDefault, cycle.origin);
				return {
					model: currentModel,
					thinkingLevel: this.thinkingLevel,
					isScoped: true,
					skippedModels,
				};
			}
			this._assertModelUsableForSwitch(next.model, liveContextTokens);
			const duringTurn = this.isStreaming;
			this.sessionManager.appendModelChange(
				next.model.provider,
				next.model.id,
				undefined,
				currentModel?.provider,
				currentModel?.id,
				{ origin: cycle.origin, duringTurn },
			);
			if (cycle.persistDefault) this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._sessionLogger.info(
				"model_change",
				modelChangeLogFields({
					origin: cycle.origin,
					from: currentModel,
					to: next.model,
					duringTurn,
					persistDefault: cycle.persistDefault,
				}),
			);
			// #1873: the cycle commits here rather than through `_switchActiveModel`, so it
			// has to supersede a held switch itself - otherwise cycling onto a model that
			// fits leaves an older hold to reclaim the session on the next message.
			this._clearPendingModelSwitch();
			// Post-switch, same contract as _switchActiveModel: the level in force AFTER the cycle.
			this._emit({
				type: "model_changed",
				model: next.model,
				thinkingLevel: this.thinkingLevel,
				source: "cycle",
				origin: cycle.origin,
				...(currentModel === undefined ? {} : { previousModel: currentModel }),
				duringTurn,
			});
			this._emitServiceTierChangeIfNeeded(previousTier, previousFastMode);

			const cycleResult: ModelCycleResult = {
				model: next.model,
				thinkingLevel: this.thinkingLevel,
				isScoped: true,
				skippedModels,
			};
			if (systemPromptChange) {
				cycleResult.systemPromptChange = systemPromptChange;
			}
			return cycleResult;
		} catch (error) {
			if (currentModel) this.agent.state.model = currentModel;
			else delete (this.agent.state as { model?: Model<Api> }).model;
			this.agent.state.systemPrompt = previousSystemPrompt;
			this._currentServiceTier = previousTier;
			throw error;
		}
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Refreshes per-model memory, never the startup default; explicit save controls own that setting.
	 */
	setThinkingLevel(level: ThinkingLevel, origin?: ModelChangeOrigin): void {
		this._setThinkingLevel(level, true, { level, source: "explicit" }, origin, true);
		this._thinkingLevelSource = this.thinkingLevel === level ? "explicit" : "clamped";
	}

	/**
	 * Set the thinking level for this session without changing the global default.
	 * The effective level is still persisted in this session's history.
	 */
	setSessionThinkingLevel(level: ThinkingLevel, origin?: ModelChangeOrigin): void {
		this._setThinkingLevel(level, false, { level, source: "explicit" }, origin, true);
		this._thinkingLevelSource = this.thinkingLevel === level ? "explicit" : "clamped";
	}

	private _setThinkingLevel(
		level: ThinkingLevel,
		rememberModelLevel: boolean,
		selection: ThinkingSelection | undefined,
		trigger?: ModelChangeOrigin,
		stampNoOpEffect = false,
	): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const previousSelection = this.agent.state.thinkingSelection;
		// senpi#2395: a model switch hands over a selection it already clamped; keep the level it asked for.
		const incoming = selection as ClampedThinkingSelection | undefined;
		const requestedLevel = incoming?.requested !== undefined && incoming.level === level ? incoming.requested : level;
		const effectiveSelection = clampThinkingSelection(selection, requestedLevel, effectiveLevel, this.model);
		const selectionChanged =
			previousSelection?.level !== effectiveSelection?.level ||
			previousSelection?.source !== effectiveSelection?.source ||
			previousSelection?.legacyVariantId !== effectiveSelection?.legacyVariantId ||
			(previousSelection as ClampedThinkingSelection | undefined)?.requested !==
				(effectiveSelection as ClampedThinkingSelection | undefined)?.requested;
		const isChanging = effectiveLevel !== previousLevel;
		if (isChanging || selectionChanged) {
			this._retryFallback.noteManualThinkingLevel();
		}

		this.agent.state.thinkingLevel = effectiveLevel;
		this.agent.state.thinkingSelection = effectiveSelection;

		if (rememberModelLevel) {
			if (this.supportsThinking() || effectiveLevel !== "off") this._lastManualThinkingLevel = effectiveLevel;
			const model = this.model;
			if (model) {
				this.settingsManager.setModelThinkingLevel(model.provider, model.id, effectiveLevel);
			}
		}

		if (isChanging || selectionChanged) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel, effectiveSelection, trigger, this.model);
			const model = this.model;
			if (isChanging && model !== undefined && supportsConfigurationUpdate(model)) {
				this.agent.state.reasoningBaseline ??= previousLevel;
				this.sessionManager.appendConfigurationUpdate(effectiveLevel);
				this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
			this._emitHighReasoningWarningIfNeeded();
			this._emitThinkingClampWarningIfNeeded();
		} else if (stampNoOpEffect && trigger?.effectId !== undefined) {
			// A no-op RPC effect still needs proof it applied if the process dies before its receipt.
			this.sessionManager.appendThinkingLevelChange(effectiveLevel, effectiveSelection, trigger, this.model);
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

	private _emitThinkingClampWarningIfNeeded(): void {
		const notice = getThinkingClampNotice(this.thinkingSelection, this.model);
		if (!notice) return;
		const key = this._thinkingClampWarningKey(notice);
		if (this._shownThinkingClampWarningKeys.has(key)) return;
		this._shownThinkingClampWarningKeys.add(key);
		this._emit({ type: "thinking_level_clamped", ...notice });
	}

	private _thinkingClampWarningKey(notice: ThinkingClampNotice): string {
		return `${notice.provider}/${notice.modelId}:${notice.requestedLevel}`;
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

	/**
	 * The level a model switch lands on (senpi#3819): a fallback's ephemeral level, else this session's
	 * last level for the model, else a favorite's `:level`, else the model's global last-used level,
	 * else the model's own default, else the configured default - clamped to what the model supports.
	 */
	private _getThinkingForModelSwitch(
		model: Model<Api>,
		explicitLevel?: ThinkingLevel,
		explicitSelection?: ThinkingSelection,
		ephemeral = false,
	): { level: ThinkingLevel; selection?: ThinkingSelection; source: ThinkingLevelSource } {
		const candidates: ReadonlyArray<readonly [ThinkingLevel | undefined, ThinkingLevelSource]> =
			ephemeral && explicitLevel !== undefined
				? [[explicitLevel, "fallback"]]
				: [
						[this._sessionThinkingMemory.levelFor(model), "session"],
						[explicitLevel, "explicit"],
						[this.settingsManager.getModelThinkingLevel(model.provider, model.id), "global"],
						// senpi#2196: the model's own default outranks the configured default and carries no provenance.
						[model.defaultThinkingLevel, "model-default"],
						[this._lastManualThinkingLevel ?? this.settingsManager.getDefaultThinkingLevel(), "default"],
					];
		const found = candidates.find(([candidate]) => candidate !== undefined);
		const requested = found?.[0] ?? DEFAULT_THINKING_LEVEL;
		const foundSource = found?.[1] ?? "default";
		const selection: ThinkingSelection | undefined =
			found === undefined || foundSource === "model-default"
				? undefined
				: foundSource === "explicit" && explicitSelection
					? explicitSelection
					: { level: requested, source: "explicit" };
		const fromGlobalDefault = found !== undefined && foundSource === "default";
		const level = this._clampThinkingLevel(requested, getSupportedThinkingLevels(model) as ThinkingLevel[]);
		const requestClamped = level !== requested && foundSource !== "default" && foundSource !== "fallback";
		return {
			level,
			// senpi#2395: the global default is a default, not a request, so its clamp records and warns nothing.
			selection: clampThinkingSelection(selection, fromGlobalDefault ? level : requested, level, model),
			source: requestClamped ? "clamped" : foundSource,
		};
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
		this._emitSessionSettingsChanged();
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
		this._emitSessionSettingsChanged();
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

	private _recordUserAbort(): void {
		this._suppressQueuedContinuationAfterUserAbort = true;
		this._userAbortGeneration += 1;
	}

	private async _abortActiveAgentAndRetry(source: "user" | "system"): Promise<void> {
		this.abortRetry();
		this.abortBranchSummary();
		if (this._userAbortPromise === undefined) {
			const boundaryJoin = this._abortProvenance.joinOpenBoundary(source);
			if (boundaryJoin !== undefined) {
				if (boundaryJoin.userOwned) this._recordUserAbort();
				return;
			}
		}
		if (this._userAbortPromise) {
			const joined = this._abortProvenance.join(source, this.isStreaming);
			if (joined.userOwned) this._recordUserAbort();
			if (joined.abortCurrentAgent) this.agent.abort();
			await this._userAbortPromise;
			return;
		}
		if (this.isStreaming && this._abortProvenance.begin(source)) this._recordUserAbort();

		const abortPromise = (async () => {
			this.agent.abort();
			await this._waitForIdleAfterAbort();
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

	/** Generate the built-in summary while preserving fork routing identity and transforms. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		requestModel: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		extraBody: Record<string, unknown> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		env: Record<string, string> | undefined,
		reason: CompactionReason,
		thinkingLevel: ThinkingLevel,
	): Promise<CompactionResult> {
		let cacheFriendly: CacheFriendlySummaryOptions | undefined;

		if (areExperimentalFeaturesEnabled()) {
			const systemPrompt = this.agent.state.systemPrompt;
			const tools = this.agent.state.tools.slice();
			const buildSourceContext = (messages: AgentMessage[]) =>
				this.agent.buildProviderContext({ systemPrompt, messages: messages.slice(), tools: tools.slice() }, signal);
			const fullContext = await buildSourceContext(this.agent.state.messages);
			const isExactPrefix = (candidate: Context): boolean =>
				candidate.messages.length > 0 &&
				candidate.messages.length <= fullContext.messages.length &&
				isDeepStrictEqual(candidate.messages, fullContext.messages.slice(0, candidate.messages.length));

			let sourceContext: Context | undefined;
			if (preparation.messagesToSummarize.length > 0 && preparation.sourceMessages) {
				const candidate = await buildSourceContext(preparation.sourceMessages);
				if (isExactPrefix(candidate)) sourceContext = candidate;
			}

			let turnPrefixSourceContext: Context | undefined;
			if (
				preparation.isSplitTurn &&
				preparation.turnPrefixMessages.length > 0 &&
				preparation.turnPrefixSourceMessages
			) {
				const candidate = await buildSourceContext(preparation.turnPrefixSourceMessages);
				const providerTurnPrefix = await this.agent.convertToLlm(preparation.turnPrefixMessages.slice());
				if (
					isExactPrefix(candidate) &&
					providerTurnPrefix.length > 0 &&
					providerTurnPrefix.length <= candidate.messages.length &&
					isDeepStrictEqual(candidate.messages.slice(-providerTurnPrefix.length), providerTurnPrefix)
				) {
					turnPrefixSourceContext = candidate;
				}
			}

			if (sourceContext || turnPrefixSourceContext) {
				cacheFriendly = {
					sourceContext,
					turnPrefixSourceContext,
					requestOptions: {
						sessionId: this.agent.sessionId,
						onPayload: this.agent.onPayload,
						onResponse: this.agent.onResponse,
						transport: this.agent.transport,
						thinkingBudgets: this.agent.thinkingBudgets,
						maxRetryDelayMs: this.agent.maxRetryDelayMs,
					},
				};
			}
		}

		return compact(
			preparation,
			requestModel,
			apiKey,
			headers,
			customInstructions,
			signal,
			extraBody,
			// The routed thinking level under a virtual selection, the session's otherwise.
			thinkingLevel,
			this.agent.streamFunction,
			env,
			this.agent.transformContext,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			this.sessionManager.getSessionId(),
			cacheFriendly,
		);
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
		// Manual compaction is the user's explicit remedy for a blocked admission
		// (#7921 case 6).
		this._releaseBlockedPostCompactionAdmission();
		const pathEntries = this.sessionManager.getBranch();
		const settings = cursorOverflowCompactionSettings(this._getCompactionSettings(model), model.provider, "manual");
		if (!prepareCompaction(pathEntries, settings)) {
			const requestId = randomUUID();
			const lastEntry = pathEntries[pathEntries.length - 1];
			const error = new Error(
				lastEntry?.type === "compaction" ? "Already compacted" : "Nothing to compact (session too small)",
			);
			const errorMessage = formatCompactionFailure("compaction", error.message);
			this._emit({ type: "compaction_start", reason: "manual", requestId });
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: false,
				willRetry: false,
				requestId,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted: false,
				willRetry: false,
				fromExtension: false,
			});
			throw error;
		}

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
			this._clearResumeCompactionRequirementIfFits();
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
			const errorMessage = aborted
				? undefined
				: formatCompactionFailure("compaction", message, { model: this._compactionFailureModel() });
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				requestId,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension: false,
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
		if (
			options.expectedWarmAnchor !== undefined &&
			!isWarmSummaryAnchorValid(options.expectedWarmAnchor, this.sessionManager.getBranch())
		) {
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
			this._emit({
				type: "compaction_start",
				reason: options.reason,
				requestId,
			});
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
			this._clearResumeCompactionRequirementIfFits();
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
				errorMessage: aborted
					? undefined
					: formatCompactionFailure("compaction", message, { model: this._compactionFailureModel() }),
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
		if (!aborted) this._resumeQueuedMessagesAfterCompaction();
	}

	private async _executeCompaction(request: CompactionExecutionRequest): Promise<CompactionExecutionResult> {
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
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
			const resolvedSettings = this._getCompactionSettings();
			const settings = cursorOverflowCompactionSettings(
				request.keepRecentTokensOverride === undefined
					? resolvedSettings
					: { ...resolvedSettings, keepRecentTokens: request.keepRecentTokensOverride },
				this.model?.provider,
				request.reason,
			);

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

				const compactionModel = this._resolveCompactionModel(model);
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
					// A configured compaction.model override redirects only the
					// summarization call to that model; every other part of the session
					// (lifecycle record, preparation, branch) still tracks the session
					// model. Falls back to the session model when the override is unset
					// or cannot be resolved.
					const {
						model: requestModel,
						apiKey,
						headers,
						extraBody,
						env,
						thinkingLevel,
					} = await this._getCompactionRequestAuth(
						compactionModel,
						signal,
						this._summarizationRetryCallbacks({ source: "compaction", reason: request.reason }),
					);
					compactionResult = await this._runDefaultCompaction(
						preparation,
						requestModel,
						apiKey,
						headers,
						extraBody,
						request.customInstructions,
						signal,
						env,
						request.reason,
						thinkingLevel,
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

			if (await this._wouldCompactionOverflow(pathEntries, compactionResult, fromExtension, model)) {
				return await this._rejectCompaction(request, requestId, operationId, "would-overflow", false);
			}

			const latestConfigurationEffort = this.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "configuration_update")?.reasoning.effort;
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
			const modelAfterCompaction = this.model;
			if (
				latestConfigurationEffort !== undefined &&
				modelAfterCompaction !== undefined &&
				supportsConfigurationUpdate(modelAfterCompaction)
			) {
				this.sessionManager.appendConfigurationUpdate(latestConfigurationEffort);
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
			this._delegatedCompactionKey = undefined;
			if (request.owner === "compaction" && this._compactionAbortController === request.controller) {
				this._compactionAbortController = undefined;
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

			// Shared success seam: every senpi-owned compaction apply (manual /compact,
			// extension applyCompaction, pre-prompt and auto compaction) funnels through
			// here after the compaction entry is appended and the success event emitted.
			await this._onCompactionContextChanged();

			return {
				accepted: true,
				requestId,
				result: compactionResult,
				compactionEntry: savedEntry,
				fromExtension,
			};
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

	private async _wouldCompactionOverflow(
		pathEntries: SessionEntry[],
		compactionResult: CompactionResult,
		fromExtension: boolean,
		model: Model<Api>,
	): Promise<boolean> {
		return wouldCompactionOverflow(
			pathEntries,
			compactionResult,
			fromExtension,
			model,
			this._getCompactionSettings(),
		);
	}

	/**
	 * Replaces agent state with the canonical session context while keeping exact
	 * message objects whose message_end persistence is still queued. Identities
	 * already present in the session context are kept from the context only, so
	 * nothing is duplicated; the queued message_end still owns exactly-once
	 * persistence for the rest.
	 */
	private _stripTrailingFailedAssistants(): number {
		const messages = this.agent.state.messages;
		let end = messages.length;
		while (end > 0) {
			const candidate = messages[end - 1];
			if (candidate?.role !== "assistant") break;
			const stopReason = (candidate as AssistantMessage).stopReason;
			if (stopReason !== "error" && stopReason !== "length") break;
			end -= 1;
		}
		const stripped = messages.length - end;
		if (stripped > 0) {
			this.agent.state.messages = messages.slice(0, end);
			this._incrementMessageRevision();
		}
		return stripped;
	}

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
		if (rejectionCause === "external-owner" && this.model) {
			this._delegatedCompactionKey = { provider: this.model.provider, id: this.model.id };
		}
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
	 * A turn needs a selected model whose provider has credentials. Every path that starts a turn checks
	 * this before admission, so a first run with no provider reports how to log in instead of failing
	 * deeper in compaction or the provider request.
	 */
	private async _assertModelReadyForTurn(): Promise<void> {
		if (!this.model) {
			throw new ModelNotReadyError(formatNoModelSelectedMessage(), "no_model_selected");
		}
		const hasConfiguredAuth =
			this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
			(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
		if (hasConfiguredAuth) {
			// A provider is ready again: a later refusal is a new episode the user should hear about.
			this._providerRequiredNoticed = false;
			return;
		}
		if (this._modelRuntime.isUsingOAuth(this.model.provider)) {
			throw new ModelNotReadyError(
				`Authentication failed for "${this.model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${this.model.provider}' to re-authenticate.`,
				"provider_credentials_expired",
				this.model.provider,
			);
		}
		throw new ModelNotReadyError(
			formatNoApiKeyFoundMessage(this.model.provider),
			"provider_credentials_missing",
			this.model.provider,
		);
	}

	/** Shows the provider guidance for a refused background turn once until a turn is admitted again. */
	private _noticeProviderRequired(notice: string): void {
		if (this._providerRequiredNoticed) return;
		this._providerRequiredNoticed = true;
		this._emit({ type: "provider_required", notice });
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _enforceCompactionBeforeProvider(
		assistantMessage: AssistantMessage | undefined,
		skipAbortedCheck: boolean,
		inlineReason: "pre_prompt" | "threshold",
		retryAfterCompaction = false,
	): Promise<boolean> {
		this._releaseBlockedPostCompactionAdmissionIfReduced();
		const blockedAdmission = this._blockedPostCompactionAssistant;
		if (blockedAdmission !== undefined && blockedAdmission.assistant === assistantMessage) {
			throw new RequiredCompactionError();
		}

		const settings = this._getCompactionSettings();
		const model = this.model;
		if (this._pendingModelSwitch !== undefined) {
			return await this._applyPendingModelSwitch(assistantMessage, skipAbortedCheck, inlineReason);
		}
		if (this._resumeCompactionRequirement !== undefined) {
			if (!model) throw new RequiredCompactionError();
			// The requirement was projected at resume, possibly on another model or before a manual
			// /compact (#2589, #2488). It only blocks while the CURRENT context still does not fit the
			// CURRENT model; otherwise the normal threshold path below decides, so a provider lane that
			// owns compaction (#1174) is never asked to compact a context that already fits.
			if (this._resumeRequirementStillBlocks(model, settings)) {
				const compacted = await this._runPrePromptCompaction(assistantMessage, skipAbortedCheck, inlineReason);
				if (!compacted) throw new RequiredCompactionError();
				if (this._resumeRequirementStillBlocks(model, settings)) throw new RequiredCompactionError();
				this._resumeCompactionRequirement = undefined;
				return true;
			}
			this._resumeCompactionRequirement = undefined;
		}
		const compacted = assistantMessage
			? await this._checkCompaction(assistantMessage, skipAbortedCheck, inlineReason, retryAfterCompaction)
			: false;
		if (compacted || (assistantMessage && this._postCompactionUsageExemptAssistants.has(assistantMessage))) {
			return compacted;
		}
		const contextTokens = this._estimatePrePromptContextTokens();

		// Under a virtual selection, the physical model of the latest response supplies the limits;
		// before one, the virtual model's declared limits apply. An undeclared window (<= 0) is unknown, so
		// admission never refuses a turn as "already over the threshold" (#2677). Compaction after a turn
		// (`_checkCompaction`) still runs and rejects against a 0 window, as it did before.
		const limitsModel = this._limitsModel();
		if (
			!settings.enabled ||
			!limitsModel ||
			limitsModel.contextWindow <= 0 ||
			!shouldCompact(contextTokens, limitsModel.contextWindow, settings)
		) {
			return false;
		}

		const assistantBeforeLatestCompaction =
			assistantMessage !== undefined && this._isAssistantFromBeforeLatestCompaction(assistantMessage);
		if (assistantBeforeLatestCompaction && assistantMessage) {
			const compacted = await this._runPrePromptCompaction(assistantMessage, skipAbortedCheck, inlineReason);
			if (compacted) return true;
		}
		if (this._isCompactionOnCooldown() || this._isCompactionDelegated() || this._hasSupersedingCompactionClaim()) {
			return false;
		}
		throw new RequiredCompactionError();
	}

	/** Share resume's branch provenance rule without projecting trusted usage on every request. */
	private _estimatePrePromptContextTokens(additions: readonly AgentMessage[] = []): number {
		const branch = this.sessionManager.getBranch();
		const messages = [...this.sessionManager.buildSessionContext().messages, ...additions];
		const estimate = estimateContextTokens(messages);
		const usageMessage = estimate.lastUsageIndex === null ? undefined : messages[estimate.lastUsageIndex];
		const usageEntryId = usageMessage ? getSessionContextEntryId(usageMessage) : undefined;
		let needsProjection = false;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (usageEntryId !== undefined && entry.id === usageEntryId) break;
			if (entry.type === "compaction" || entry.type === "context_edit") {
				needsProjection = true;
				break;
			}
		}
		if (!needsProjection) return estimate.tokens;

		if (this._prePromptProjection?.branch !== branch) {
			this._prePromptProjection = { branch, projection: this.sessionManager.buildSessionProjection() };
		}
		const { projection } = this._prePromptProjection;
		return estimateProjectedContextTokens({ ...projection, messages: [...projection.messages, ...additions] }, branch)
			.tokens;
	}

	/**
	 * Pending queued input the provider will also carry on this turn. Steering and
	 * follow-up text enqueued after the admission projection was assembled - by a
	 * `before_agent_start` handler, an extension action, or the user racing the
	 * gate - is drained into the same run, so the final gate must measure it
	 * (#7921 case 5).
	 */
	private _pendingQueuedInputMessages(): AgentMessage[] {
		const timestamp = Date.now();
		return [...this._steeringMessages, ...this._followUpMessages].map((text) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text }],
			timestamp,
		}));
	}

	/**
	 * The normal pre-prompt check only estimates persisted session context. This
	 * final gate also includes turn-local messages which the provider will see:
	 * the current prompt, next-turn custom messages, before_agent_start additions,
	 * and steering or follow-up input queued after that projection was assembled.
	 * Compaction rewrites only session context, so callers retain and reapply
	 * their already-assembled one-shot additions after it succeeds.
	 */
	private async _enforceFinalProviderAdmission(messages: readonly AgentMessage[]): Promise<void> {
		// User-only prompts are deliberately admitted without this gate: prompt
		// admission must never brick on a rejected or cooled-down compaction
		// (issues #531/#886), so oversized user prompts rely on threshold
		// compaction — which also samples the local transcript estimate — and on
		// provider-overflow recovery. This gate closes the separate gap opened by
		// turn-local custom additions and by late queued input, neither of which the
		// pre-prompt check can observe.
		const lateQueuedMessages = this._pendingQueuedInputMessages();
		if (!messages.some((message) => message.role === "custom") && lateQueuedMessages.length === 0) return;

		// Same limits rule as the pre-provider threshold check: an undeclared window is unknown, so this gate
		// never refuses a turn as oversized (#2677).
		const model = this._limitsModel();
		if (!model || model.contextWindow <= 0) return;
		const settings = this._getCompactionSettings();
		const reserveTokens = resolveEffectiveReserveTokens(model.contextWindow, settings);
		const isOversized = (): boolean => {
			const contextTokens = this._estimatePrePromptContextTokens([
				...messages,
				// Re-read the queues on every sample: this closure is evaluated again
				// after compaction, when more input may have arrived.
				...this._pendingQueuedInputMessages(),
			]);
			return contextTokens > model.contextWindow - reserveTokens;
		};

		if (!settings.enabled || !isOversized()) return;

		const lastAssistantMessage = this._findLastAssistantMessage();
		if (!lastAssistantMessage) {
			throw new RequiredCompactionError();
		}

		const compacted = await this._runPrePromptCompaction(lastAssistantMessage, false, "pre_prompt");
		if (!compacted && this._isCompactionDelegated()) return;
		if (!compacted && this._hasSupersedingCompactionClaim()) return;
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
		const settings = this._getCompactionSettings();

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		const limitsModel =
			this.model && isVirtualModel(this.model)
				? this._modelRuntime.getPhysicalModel(assistantMessage.provider, assistantMessage.model)
				: this.model;
		const sameModel =
			limitsModel &&
			isSameOverflowSource(
				assistantMessage,
				limitsModel,
				this._modelRuntime.getCompatibilityRequestConfig(limitsModel).upstreamModelId,
			);
		const contextWindow = (limitsModel ?? this.model)?.contextWindow ?? 0;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		// The inline (pre-prompt) caller re-samples the current context itself and
		// owns the fail-closed rejection, so only the automatic route needs the
		// narrowed exemption here: fresh post-boundary content still counts even
		// though this message's own usage predates the boundary (#7921 case 5).
		if (
			this._isAssistantFromBeforeLatestCompaction(assistantMessage) &&
			(inlineReason !== undefined || !this._exceedsPolicyByContentEstimate())
		) {
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
		// A boundary context_edit can omit this assistant or change the context its usage measured.
		const branch = this.sessionManager.getBranch();
		let projection: SessionProjection | undefined;
		const buildProjection = () => (projection ??= this.sessionManager.buildSessionProjection());
		const usageScope = resolveAssistantUsageScope(
			branch,
			buildProjection,
			this._findPersistedMessageEntryId(assistantMessage),
		);
		const overflowEvidenceApplies =
			assistantMessage.stopReason === "error"
				? usageScope.retainedForExplicitRecovery
				: usageScope.usageMatchesProjection;
		// Pre-admission ("threshold") runs only before a natural next request: the truncated response's
		// failed tool results or queued input follow it, so there is no truncated final attempt to retry.
		// The desired output limit is the one of the model that produced the message (the physical model under a virtual selection).
		const recoverableLength =
			inlineReason !== "threshold" &&
			sameModel &&
			usageScope.projected &&
			isRecoverableLength(assistantMessage, limitsModel?.maxTokens ?? 0);
		const isOverflow =
			(overflowEvidenceApplies &&
				isContextOverflow(assistantMessage, contextWindow) &&
				(sameModel || currentContextNeedsCompaction)) ||
			recoverableLength ||
			this._isCursorPayloadOverflow(assistantMessage);
		if (isOverflow && !settings.enabled && !isTurnStuckOnContextOverflow(assistantMessage, contextWindow)) {
			return false;
		}
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

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				const compacted = await this._runAutoCompaction("overflow", false);
				if (
					!compacted &&
					this._compactionLifecycle.state.status === "failed" &&
					this._compactionLifecycle.state.rejectionCause !== "external-owner" &&
					getLatestCompactionEntry(this.sessionManager.getBranch()) !== null
				) {
					this._blockedPostCompactionAssistant = {
						assistant: assistantMessage,
						contentTokens: this._blockedAdmissionContentTokens(),
					};
				}
				return compacted;
			}

			// A new turn admission is a fresh overflow episode, whatever an earlier turn spent:
			// the prompt or continuation it admits must reach a compaction, not a stale latch.
			if (inlineReason === "pre_prompt") this._overflowRecoveryRungs = 0;
			if (this._overflowRecoveryRungs >= OVERFLOW_RECOVERY_RUNGS) {
				const errorMessage = OVERFLOW_RECOVERY_EXHAUSTED_MESSAGE;
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

			// Case 1: remove the failed or truncated message from agent state, compact, and
			// retry. The message remains in session history but is excluded from retry context.
			// The second rung keeps nothing but the summary and the turn being answered: a
			// retry that is still too long after the configured tail was kept needs a
			// smaller re-send, not the same one.
			this._overflowRecoveryRungs += 1;
			const keepRecentTokensOverride = this._overflowRecoveryRungs >= 2 ? 0 : undefined;
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
				? await this._runPrePromptCompaction(
						assistantMessage,
						skipAbortedCheck,
						"overflow",
						willRetry,
						false,
						keepRecentTokensOverride,
					)
				: keepRecentTokensOverride === undefined
					? await this._runAutoCompaction("overflow", willRetry)
					: await this._runAutoCompaction("overflow", willRetry, { keepRecentTokensOverride });
			if (!compacted && removedOverflowAssistant) {
				this._restoreAgentMessagesFromSession();
				this._incrementMessageRevision();
			}
			if (!compacted && inlineReason && !this._isCompactionDelegated() && !this._hasSupersedingCompactionClaim()) {
				if (this._compactionSkippedTooSmall) {
					this._compactionSkippedTooSmall = false;
					const provider = this.model?.provider;
					if (provider === "cursor" || provider === "cursor-cli-oauth") {
						this._truncateAgentMessagesToLastUserTurn();
					}
					return true;
				}
				throw new RequiredCompactionError();
			}
			if (compacted && willRetry) this._failedResponse = assistantMessage;
			return compacted;
		}

		// The first ordinary response can carry provider usage calculated before
		// compaction. Consume that exemption only after proving this is not an
		// overflow, then retain the decision for later admission re-sampling.
		// It is consumed even when threshold compaction is switched off: the
		// exemption is what releases input queued while that response started,
		// so leaving it armed parked that input until a later compaction (#4036).
		if (this._consumePostCompactionUsageExemption(assistantMessage)) return false;

		// Stuck-overflow recovery above runs regardless of the flag; threshold
		// compaction below is the proactive path the user switched off (#1422).
		if (!settings.enabled) return false;

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		let staleUsageContentTokens: number | undefined;
		if (inlineReason) {
			contextTokens = this._estimatePrePromptContextTokens();
		} else {
			const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
			if (!usageScope.usageMatchesProjection) {
				contextTokens = estimateProjectedContextTokens(buildProjection(), branch).tokens;
			} else if (assistantMessage.stopReason !== "error" && directContextTokens !== 0) {
				contextTokens = this._resolveThresholdContextTokens(directContextTokens);
			} else {
				const messages = filterContextExcludedMessages(this.agent.state.messages);
				const estimate = estimateContextTokens(messages);
				if (estimate.lastUsageIndex !== null) {
					// Verify the usage source is post-compaction. Kept pre-compaction messages
					// have stale usage reflecting the old (larger) context and would falsely
					// trigger compaction right after one just finished.
					const usageMsg = messages[estimate.lastUsageIndex];
					if (
						compactionEntry &&
						usageMsg.role === "assistant" &&
						this._isAssistantFromBeforeLatestCompaction(usageMsg)
					) {
						// Drop only the stale usage number; the messages themselves still count.
						staleUsageContentTokens = estimateMessagesTokens(messages);
						if (!shouldCompact(staleUsageContentTokens, contextWindow, settings)) return false;
					}
				}
				contextTokens = staleUsageContentTokens ?? estimate.tokens;
			}
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			if (inlineReason) {
				const compacted = await this._runPrePromptCompaction(
					assistantMessage,
					skipAbortedCheck,
					inlineReason,
					retryAfterCompaction,
				);
				if (compacted || !this._compactionSkippedTooSmall) return compacted;
				// Everything compactable sits inside the recent window, typically one long tool-heavy turn on a
				// small window whose system prompt and tool schemas already fill most of it (senpi#2925). Split
				// the current turn: summarize its earlier steps and keep only the latest one, as the overflow
				// path's second rung does.
				this._compactionSkippedTooSmall = false;
				return await this._runPrePromptCompaction(
					assistantMessage,
					skipAbortedCheck,
					inlineReason,
					retryAfterCompaction,
					false,
					0,
				);
			} else {
				const compacted = await this._runAutoCompaction("threshold", retryAfterCompaction);
				if (
					!compacted &&
					this._compactionLifecycle.state.status === "failed" &&
					this._compactionLifecycle.state.rejectionCause !== "external-owner" &&
					getLatestCompactionEntry(this.sessionManager.getBranch()) !== null
				) {
					this._blockedPostCompactionAssistant = {
						assistant: assistantMessage,
						contentTokens: this._blockedAdmissionContentTokens(),
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

	/**
	 * Compaction claims are last-writer-wins: a newer admission aborts the
	 * incumbent controller (_claimCompactionController). When the failed attempt
	 * lost that race, a live claimant now owns the route and re-gates admission
	 * itself, so the loser must not surface RequiredCompactionError (issue #886).
	 * A user abort leaves no live claimant behind and keeps throwing.
	 */
	private _hasSupersedingCompactionClaim(): boolean {
		const claimant = this._compactionAbortController ?? this._autoCompactionAbortController;
		return claimant !== undefined && !claimant.signal.aborted;
	}

	private _isCompactionDelegated(): boolean {
		const model = this.model;
		return (
			this._delegatedCompactionKey !== undefined &&
			model !== undefined &&
			this._delegatedCompactionKey.provider === model.provider &&
			this._delegatedCompactionKey.id === model.id
		);
	}

	private async _runPrePromptCompaction(
		lastAssistantMessage: AssistantMessage | undefined,
		skipAbortedCheck: boolean,
		reason: "pre_prompt" | "overflow" | "threshold" = "pre_prompt",
		willRetry = false,
		allowSummaryOnly = false,
		keepRecentTokensOverride?: number,
	): Promise<boolean> {
		// The flag reports THIS attempt's "nothing to compact" outcome only; a value left by an earlier attempt
		// must not make a caller treat a cancelled or rejected compaction as too small (senpi#2925 review).
		this._compactionSkippedTooSmall = false;
		if (isAutomaticCompactionBlocked(this.sessionManager.getBranch(), this.model, this._getCompactionSettings())) {
			return false;
		}
		// An earlier external-owner rejection never answers for a rejected request
		// awaiting its retry: whether the owner can recover it depends on the request
		// that failed, so ask again. A completed turn keeps the sticky delegation (#1174).
		if (!(reason === "overflow" && willRetry) && this._isCompactionDelegated()) return false;
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
				keepRecentTokensOverride,
			});
			if (
				!execution.accepted &&
				lastAssistantMessage &&
				isContextOverflow(lastAssistantMessage, this.model?.contextWindow ?? 0)
			) {
				this._overflowRecoveryRungs = 0;
			}
			return execution.accepted;
		} catch (error) {
			if (!compactionExecutionOwnsTerminalTransition(error)) {
				return false;
			}
			if (lastAssistantMessage && isContextOverflow(lastAssistantMessage, this.model?.contextWindow ?? 0)) {
				this._overflowRecoveryRungs = 0;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this._compactionSkippedTooSmall = shouldRetryOverflowWithoutCompact(false, errorMessage);
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
		const settings = this._getCompactionSettings();
		if (!model || !settings.enabled) return;

		const contextTokens = this._estimatePrePromptContextTokens();
		// An explicit user prompt passes the proactive policy in the compaction
		// extension's before_agent_start, which automatic continuations never emit.
		// Sampling the same predicate here makes both routes compact at the same
		// usage instead of letting a continuation ride past the threshold up to the
		// hard valve (#7921 case 4).
		const atHardLimit = shouldCompact(contextTokens, model.contextWindow, settings);
		const overProactiveThreshold = shouldTriggerCompaction(
			{
				tokens: contextTokens,
				contextWindow: model.contextWindow,
				percent: model.contextWindow > 0 ? (contextTokens / model.contextWindow) * 100 : 0,
			},
			model.contextWindow,
			settings,
		);
		if (!atHardLimit && !overProactiveThreshold) return;

		const compacted = await this._runPrePromptCompaction(this._findLastAssistantMessage(), true, "pre_prompt");
		if (!compacted) {
			// Proactive pressure alone must never brick an automatic continuation:
			// only the hard reserve valve stays fail-closed (#531/#886).
			if (
				!atHardLimit ||
				this._isCompactionOnCooldown() ||
				this._isCompactionDelegated() ||
				this._hasSupersedingCompactionClaim()
			) {
				return;
			}
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

			// Pre-admission restore point. A senpi-owned compaction that succeeds
			// while a run is still active releases its refusal pin through
			// _onCompactionContextChanged() but cannot restore there: model-select
			// work must stay ordered behind the session-work barrier while the run
			// owns it. Every post-compaction continuation admission - auto/overflow
			// compaction recovery, _resumeQueuedMessagesAfterCompaction(), the
			// agent_end queued continuation and the retry continuation - is scheduled
			// through _scheduleContinuationAfterCurrentEvent() and funnels here, so
			// this is the single choke point every such request passes before
			// reaching the provider. Restoring here (a no-op when nothing is pending)
			// keeps the guarantee that the very next request after a compaction runs
			// on the primary, and precedes the admission revalidation below so that
			// check samples the restored model's context window - the same ordering
			// the retry-continuation restore uses.
			await this._maybeRestoreFallbackPrimary("continuation");

			await this._revalidateScheduledContinuationAdmission();
			if (this.agent.state.isStreaming) return "taken-over";
			if (!this._promptOwnsRun) this._transcriptWriteFailures.startRun();

			await runBoundedRetryContinuation({
				continueRun: async () => {
					if (this._continueWithQueuedInput) {
						// Joined input of a start that never ran: the transcript tail may be anything, even empty.
						this._continueWithQueuedInput = false;
						await this.agent.continueWithQueuedMessages(options);
					} else if (this._scheduledContinuationRecompacted) {
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
				abortActive: () =>
					this.agent.abort(
						new ProviderRetryWatchdogAbortError(
							providerRetryWatchdogAbortMessage(retryTimeoutMs, this.agent.streamStartTimeoutMs),
						),
					),
				timeoutMs: retryTimeoutMs,
				onStreamStarted: (listener) => {
					const unsubscribe = this.agent.subscribe((event) => {
						if (event.type !== "message_start" || event.message.role !== "assistant") return;
						unsubscribe();
						listener();
					});
					return unsubscribe;
				},
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
			this._continueWithQueuedInput = false;
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

	/** A continuation run has no prompt to reject, so a message write it lost is reported like a failed continuation. */
	private _reportContinuationTranscriptFailure(): void {
		const failure = this._transcriptWriteFailures.takeReport();
		if (!failure) return;
		const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
		this._emit({ type: "continuation_error", errorMessage: `The session file did not save this run: ${message}` });
	}

	/** Runs input that joined a start which never ran: the transcript tail may be anything, even empty. */
	private _drainJoinedInput(): void {
		if (!this.agent.hasQueuedMessages()) return;
		this._continueWithQueuedInput = true;
		this._scheduleContinuationAfterCurrentEvent();
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
				const outcome = await this._continueAgentAfterCurrentRun(options, retryTimeoutMs);
				if (retryContinuation && outcome === "taken-over") {
					DEFERRED_RETRY_QUEUE_OWNERS.delete(this);
				}
			} catch (error) {
				if (retryContinuation) {
					DEFERRED_RETRY_QUEUE_OWNERS.delete(this);
				}
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
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		options: { keepRecentTokensOverride?: number } = {},
	): Promise<boolean> {
		if (isAutomaticCompactionBlocked(this.sessionManager.getBranch(), this.model, this._getCompactionSettings())) {
			return false;
		}
		if (!(reason === "overflow" && willRetry) && this._isCompactionDelegated()) return false;
		const { keepRecentTokensOverride } = options;
		// Model identity is captured before the auth await below: a model switch during
		// that await must not change the token budgets this compaction was admitted with.
		const model = this.model;
		const finishCompactionWork = this._sessionWorkBarrier.begin();
		const agentMessagesAtStart = this.agent.state.messages.slice();
		const autoCompactionController = new AbortController();
		const requestId = randomUUID();
		this._claimCompactionController(autoCompactionController, "auto");
		const endBeforeExecution = (): false => {
			this._emit({ type: "compaction_start", reason, requestId });
			return endStarted();
		};
		const endStarted = (): false => {
			if (reason === "overflow" && this._autoCompactionAbortController === autoCompactionController) {
				this._overflowRecoveryRungs = 0;
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

		// A superseded operation owns no public events (the newer one owns its own
		// start/end); an abort of this very controller still ends it as aborted.
		const isSuperseded = (): boolean => this._autoCompactionAbortController !== autoCompactionController;

		try {
			if (!this.model) {
				return endBeforeExecution();
			}

			try {
				// Resolve once before admission so a pending auth refresh remains a
				// cancellable boundary: the controller signal lets abort()/abortCompaction()
				// cancel it (#9777). _executeCompaction resolves the policy-specific
				// auth after extension compaction hooks have had a chance to provide a
				// summary without credentials.
				await this._modelRuntime.getAuth(this.model, { signal: autoCompactionController.signal });
			} catch (error) {
				if (isSuperseded()) return false;
				if (autoCompactionController.signal.aborted) return endBeforeExecution();
				// A failed auth is a compaction failure, reported like an execution error;
				// only this controller's abort (not the error's name or text) marks it aborted.
				this._emit({ type: "compaction_start", reason, requestId });
				if (isSuperseded()) return false;
				throw new CompactionExecutionError(error, true, false);
			}
			if (isSuperseded()) return false;
			if (autoCompactionController.signal.aborted) return endBeforeExecution();

			const resolvedSettings = this._getCompactionSettings(model);
			const preparation = prepareCompaction(
				this.sessionManager.getBranch(),
				cursorOverflowCompactionSettings(
					keepRecentTokensOverride === undefined
						? resolvedSettings
						: { ...resolvedSettings, keepRecentTokens: keepRecentTokensOverride },
					model?.provider,
					reason,
				),
				reason === "overflow",
			);
			if (!preparation) {
				return endBeforeExecution();
			}
			this._emit({ type: "compaction_start", reason, requestId });
			// A synchronous compaction_start listener can supersede or abort this operation.
			if (isSuperseded()) return false;
			if (autoCompactionController.signal.aborted) return endStarted();

			const execution = await this._executeCompaction({
				controller: autoCompactionController,
				owner: "auto",
				reason,
				requestId,
				willRetry,
				agentMessagesAtStart,
				keepRecentTokensOverride,
			});
			if (!execution.accepted) {
				if (reason === "overflow") this._overflowRecoveryRungs = 0;
				return false;
			}
			if (this._autoCompactionAbortController === autoCompactionController) {
				this._autoCompactionAbortController = undefined;
			}

			if (willRetry) {
				// The rebuilt context ends with every rejected attempt of this turn that the
				// kept tail still covers (one per rung climbed so far); the retry must
				// continue from the turn they failed to answer, so strip the whole run.
				this._stripTrailingFailedAssistants();

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
			if (reason === "overflow") this._overflowRecoveryRungs = 0;
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted = isCompactionExecutionAborted(error);
			const formattedErrorMessage = aborted
				? undefined
				: formatCompactionFailure(reason === "overflow" ? "overflow-recovery" : "auto-compaction", errorMessage, {
						model: this._compactionFailureModel(),
					});
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted,
				willRetry: false,
				requestId,
				errorMessage: formattedErrorMessage,
			});
			await this._emitSessionCompactFailed({
				reason,
				errorMessage: formattedErrorMessage,
				aborted,
				willRetry: false,
				fromExtension: false,
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
	 * Toggle auto-compaction for this session only. Persisting the flag is a
	 * settings-editor concern; a session-level command (RPC `set_auto_compaction`,
	 * one thread of a multi-session host) must never rewrite the global setting
	 * for every other session on the machine (#1422).
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this._autoCompactionSessionOverride = enabled;
		this._emitSessionSettingsChanged();
	}

	/**
	 * Compaction settings for a model, defaulting to the session model so per-model
	 * token budgets (`compaction.modelOverrides`) apply to every compaction read here.
	 * Callers that captured a model before an await pass it explicitly, so a model
	 * switch during that await cannot change the budget the operation started with.
	 */
	private _getCompactionSettings(
		forModel: CompactionModelSelector | undefined = this.model,
	): ReturnType<SettingsManager["getCompactionSettings"]> {
		const settings = this.settingsManager.getCompactionSettings(forModel);
		if (this._autoCompactionSessionOverride === undefined) return settings;
		return { ...settings, enabled: this._autoCompactionSessionOverride };
	}

	private _emitSessionSettingsChanged(): void {
		this._emit({
			type: "session_settings_changed",
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			autoCompactionEnabled: this.autoCompactionEnabled,
		});
	}

	/** Whether auto-compaction is enabled for this session */
	get autoCompactionEnabled(): boolean {
		return this._autoCompactionSessionOverride ?? this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		this._sizesOnlyStartup = bindings.sizesOnly === true;
		this._promptSizeInventory = this._sizesOnlyStartup ? bindings.promptSizeInventory : undefined;
		const finishBindingWork = this._sessionWorkBarrier.begin();
		const settleSessionStart = this._beginSessionStartSettlement();
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
			// Opening a session is not explicit Resume. Install the same hold used by Stop before
			// session_start producers run, so automatic work waits quietly in notice custody.
			if (this._lifecycleBinding.controller.requiresHumanContinuation)
				this._engineTurnHold.addHold("session_hold", { key: "interrupted-run" });
			this._engineTurnHold.start();
			this.syncPromptCacheSafeWaitEnv();
			await this._extensionRunner.emit({
				...this._sessionStartEvent,
				...(this._sizesOnlyStartup ? { sizesOnly: true } : {}),
			});
			await restoreMovedState(this.sessionManager, (moved) =>
				this._extensionRunner
					.emitSessionMove({ type: "session_move_import", ...moved })
					.then((failures) => failures.length === 0),
			);
			this._enforceConfiguredDefaultTools();
			await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		} finally {
			if (this._extensionBindingPromptReadiness === bindingPromptReadiness) {
				this._extensionBindingPromptReadiness = undefined;
			}
			finishBindingWork();
			void Promise.allSettled(bindingPromptReadiness).then(settleSessionStart);
		}
		await Promise.all(bindingPromptReadiness);
		if (this._lifecycleBinding.isRestored) await this._lifecycleBinding.refreshFacts();
		else await this._lifecycleBinding.restore();
	}

	private _beginSessionStartSettlement(): () => void {
		let settle!: () => void;
		this._sessionStartSettled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		return settle;
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

		const extensions = this._resourceLoader.getExtensions().extensions;
		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: resolveDiscoveredResourcePaths(skillPaths, extensions),
			promptPaths: resolveDiscoveredResourcePaths(promptPaths, extensions),
			themePaths: resolveDiscoveredResourcePaths(themePaths, extensions),
			hookPaths: resolveDiscoveredResourcePaths(hookPaths, extensions),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this.securityNotices.setResources(this._resourceLoader.getSkills().diagnostics);
		if (skillPaths.length > 0 || promptPaths.length > 0 || themePaths.length > 0) {
			this._baseSystemPrompt = this._rebuildSystemPrompt(this._toolDeclarationNames(this.getActiveToolNames()));
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.setToolHookLifecycleObserver((event) => {
			this._emit(event);
		});
		runner.setLifecycleAttentionObserver(() => this.refreshLifecycle());
		runner.setEventHandlerBudget(
			() => ({
				warnMs: this.settingsManager.getExtensionEventHandlerWarnMs(),
				timeoutMs: this.settingsManager.getExtensionEventHandlerTimeoutMs(),
			}),
			(stall) =>
				reportExtensionHandlerStall(stall, this._sessionLogger, (message, type) =>
					runner.getUIContext().notify(message, type),
				),
			() => this._handlerTurnScope,
		);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		this._delegatedCompactionKey = undefined;
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
		if (this._lifecycleBinding.sessionId !== this.sessionId) {
			this._lifecycleBinding.dispose();
			this._lifecycleBinding = this._createLifecycleBinding();
		}
		// Activity extensions publish about work outliving a turn (background
		// terminal jobs, monitors, holds) feeds the session-busy contract. Re-bound
		// per runner; counts survive the swap so a reload cannot make live work
		// look idle to an occupancy sweep.
		this._unsubscribeWakeSources?.();
		this._unsubscribeWakeSources = runner.onBusEvent(WAKE_SOURCE_STATE_EVENT, (data) =>
			this._wakeSources.observe(data),
		);
		this._lifecycleBinding.bindFactEvents(runner);
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

		// This generation's `pi.session`: it owns the control endpoints this generation registers (senpi#3246).
		const sessionControl = createSessionControlActions({
			admission: this.externalAdmission,
			sessionManager: this.sessionManager,
			host: () => this._controlEndpointHost,
			relocationHost: () => this._relocationHost,
		});
		this._sessionControl = sessionControl;
		runner.bindCore(
			{
				sendMessage: (message, options) => {
					const reportError = (err: unknown) => {
						if (err instanceof ModelNotReadyError) {
							this._noticeProviderRequired(err.message);
							return;
						}
						runner.emitError({
							extensionPath: RUNTIME_EXTENSION_PATH,
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					};
					if (options?.triggerTurn === true) {
						if (
							this._agentSettledDelivery.deferTriggerTurn((claim) => {
								this.sendCustomMessage(message, options, claim).catch(reportError);
							})
						) {
							return;
						}
					}
					const send = () => this.sendCustomMessage(message, options).catch(reportError);
					if (this._agentSettledDelivery.defer(send)) return;
					send();
				},
				sendItemizedMessage: (message, options) => this._sendItemizedMessage(message, options),
				sendUserMessage: (content, options, inputOrigin: InputOrigin = "extension") => {
					const reportError = (err: unknown) => {
						if (err instanceof ModelNotReadyError) {
							this._noticeProviderRequired(err.message);
							return;
						}
						runner.emitError({
							extensionPath: RUNTIME_EXTENSION_PATH,
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					};
					// sendUserMessage always triggers a turn; register a settlement-deferred
					// turn claim so agent_idle is not emitted before its deferred agent_start.
					if (
						this._agentSettledDelivery.deferTriggerTurn((claim) => {
							this.sendUserMessage(content, options, claim, inputOrigin).catch(reportError);
						})
					) {
						return;
					}
					this.sendUserMessage(content, options, undefined, inputOrigin).catch(reportError);
				},
				appendEntry: (customType, data, options) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data, options);
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
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				registerRemovedToolHint: (name, hint) => {
					this.agent.removedToolHints[name] = hint;
				},
				registerLazyToolActivator: (activator) => {
					this._lazyToolActivation.register(activator);
				},
				armToolBarrier: (spec) => this.armToolBarrier(spec),
				releaseToolBarrier: (id) => this.releaseToolBarrier(id),
				getCommands,
				setModel: async (model, origin) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model, origin ?? { source: "extension" });
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				setSessionModel: async (model, origin) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setSessionModel(model, origin ?? { source: "extension" });
					return true;
				},
				setSessionThinkingLevel: (level) => this.setSessionThinkingLevel(level),
				setSessionFastMode: (enabled) => this.setSessionFastMode(enabled),
				sessionControl,
				lifecycle: this.lifecycleApi,
			},
			{
				offload: (id, args, options) =>
					offload(this._toolDispatcher, this._extensionRunner.getAllChildModules(), id, args, options),
				getModel: () => this.model,
				getServiceTier: () => this.serviceTier,
				getEffectiveServiceTier: () => this.effectiveServiceTier,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				engineTurnsHeld: () => this._engineTurnHold.holdsSource("goal"),
				noteHeldWake: (source) => this._engineTurnHold.note(source),
				getPauseState: () => this._pauseState(),
				fenceRun: (runRef) => this._runHolds.fence(runRef),
				releaseRunFence: (runRef) => this._runHolds.releaseFences("run_cancelled", [runRef]),
				questionInput: () => {
					this._humanInputAdmitted("answer");
					// Under the parent's run pause the answer is held like every person input: nothing is released or run (senpi#3811).
					// The runner captured the answer's person origin before this call, so prompt()'s run hold still holds it.
					if (this._runHolds.inheritedOwner() === undefined) {
						this._captureReleaseExtras();
						this._engineTurnInput.begin({ consumeAtSettlement: this._stopHoldLive() });
						this._engineResumeWindow = false;
					}
					// The answer's follow-on (if any) enters prompt() synchronously after this; settle once it has.
					queueMicrotask(() => {
						this._settleInputRelease()?.catch((error: unknown) => {
							this._sessionLogger.warn("input_release_settle_failed", {
								error: error instanceof Error ? error.message : String(error),
							});
						});
					});
				},
				getAgentDir: () => this._agentDir,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this._extensionEventSignal ?? this.agent.signal,
				abort: (source = "user") => {
					if (source === "system") return void this._abortActiveAgentAndRetry("system");
					if (this._extensionAbortHandler) return this._extensionAbortHandler();
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				hasQueuedPersonInput: () => this.hasQueuedPersonInput,
				isCompacting: () => this.isCompacting,
				checkReloadVeto: () => this.checkReloadVeto(),
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				getCompactionSettings: () => this._getCompactionSettings(),
				// One resolver for core and builtin compaction: a configured `compaction.model`
				// summarizes on a healthy provider too, not only after the account is spent (#830).
				getCompactionModel: () => (this.model ? this._resolveCompactionModel(this.model) : undefined),
				getPromptCacheSafeWaitSeconds: () => this.resolvePromptCacheSafeWaitSeconds(),
				getPromptCacheGoalBackstopMaxSeconds: () => this.settingsManager.getPromptCacheGoalBackstopMaxSeconds(),
				getPromptCacheKeepAliveSettings: () => this.settingsManager.getPromptCacheKeepAliveSettings(),
				onUserActivity: (listener) => this._userActivity.subscribe(listener),
				getLookAtSettings: () => {
					const global = this.settingsManager.getGlobalSettings().lookAt;
					const project = this.settingsManager.getProjectSettings().lookAt;
					return {
						enabled: project?.enabled ?? global?.enabled ?? true,
						models: project?.models ?? global?.models,
					};
				},
				getAskUserSettings: () => this.settingsManager.getAskUserSettings(),
				getBrowserEngine: () => this._browserEngine,
				getSessionEnv: () => this._sessionEnv,
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
							this._emit({
								type: "compaction_start",
								reason: "extension",
								requestId,
							});
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
								errorMessage: aborted
									? undefined
									: formatCompactionFailure("compaction", message, { model: this._compactionFailureModel() }),
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
				getPromptCachePrefixRequest: (options) =>
					this._promptCachePrefixBuilds.build(
						{
							agent: this.agent,
							runner: this._extensionRunner,
							modelRuntime: this._modelRuntime,
							ready: this._sessionStartSettled,
							getServiceTier: () => this.effectiveServiceTier,
							getBaseSystemPrompt: () => this._baseSystemPrompt,
							getBaseSystemPromptOptions: () => this._baseSystemPromptOptions,
							getBaseSystemPromptParts: () => this._baseSystemPromptParts,
							sizesOnlyStartup: this._sizesOnlyStartup,
							...(this._promptSizeInventory === undefined
								? {}
								: { promptSizeInventory: this._promptSizeInventory }),
						},
						options,
					),
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
			},
			{
				registerProvider: (name, config, extensionPath) => {
					this._modelRuntime.registerProvider(name, config, { extensionPath });
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider, extensionPath) => {
					this._modelRuntime.registerNativeProvider(provider, { extensionPath });
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
		this._bindToolSearchRemovedHints();
	}

	/** Fallback-chain configuration warnings calculated when this session started. */
	get fallbackValidationWarnings(): readonly string[] {
		return this._fallbackValidationWarnings;
	}

	/** The dispatcher every wrapped tool call and user-bash operation goes through (senpi#3566). */
	get toolDispatcher(): ToolDispatcher {
		return this._toolDispatcher;
	}

	private _isBuiltinExtensionPath(path: string): boolean {
		return (
			path.startsWith("<builtin:") || path.startsWith(BUILTIN_PATH_PREFIX) || /[\\/]senpi-codemode[\\/]/u.test(path)
		);
	}

	private _enforceConfiguredDefaultTools(): void {
		const defaultToolNames = this._defaultToolNames;
		if (defaultToolNames === undefined) return;
		this.setActiveToolsByName(
			this.getActiveToolNames().filter((name) => {
				if (defaultToolNames.has(name)) return true;
				const entry = this._toolDefinitions.get(name);
				return (
					entry !== undefined &&
					!this._isBuiltinExtensionPath(entry.sourceInfo.path) &&
					entry.sourceInfo.source !== "builtin"
				);
			}),
		);
	}

	private _refreshToolRegistry(options?: {
		activeToolNames?: string[];
		includeAllExtensionTools?: boolean;
		previousActiveToolRegistrationIds?: ReadonlyMap<string, string>;
		/** Tools to activate that were not active before, such as tools newly added to `defaultTools`. */
		addedToolNames?: readonly string[];
	}): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const defaultToolNames = this._defaultToolNames;
		const isConfiguredBuiltinTool = (tool: (typeof registeredTools)[number]): boolean =>
			(tool.sourceInfo.source !== "builtin" && !this._isBuiltinExtensionPath(tool.sourceInfo.path)) ||
			defaultToolNames === undefined ||
			defaultToolNames.has(tool.definition.name);
		const allCustomTools = [
			...registeredTools.filter(isConfiguredBuiltinTool),
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
					source: "sdk",
				}),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, {
							source: "builtin",
						}),
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
		const createToolContext = (signal: AbortSignal | undefined) => this._createToolContext(signal);
		const wrappedExtensionTools = wrapRegisteredTools(
			allCustomTools,
			runner,
			createToolContext,
			this._toolDispatcher,
		);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
				})),
			runner,
			createToolContext,
			this._toolDispatcher,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;
		this._evalOnlyToolNames = this._resolveEvalOnlyToolNames();
		this._publishEvalOnlyToolHints();
		const isDirectlyExposed = (name: string): boolean => this._isActivatedOnRegistration(name);

		const nextActiveToolNames = (
			options?.activeToolNames
				? [...options.activeToolNames]
				: [...(this._requestedActiveToolNames ?? previousActiveToolNames)]
		).filter((name) => {
			if (!isAllowedTool(name)) return false;
			const previousRegistrationIds = options?.previousActiveToolRegistrationIds;
			if (!previousRegistrationIds) return true;
			const current = this._toolDefinitions.get(name);
			return (
				current !== undefined &&
				previousRegistrationIds.get(name) === deriveExtensionRegistrationId(current.sourceInfo, name)
			);
		});
		// Newly added tools had no previous registration to match, so they skip the identity check.
		for (const name of options?.addedToolNames ?? []) {
			if (isAllowedTool(name)) nextActiveToolNames.push(name);
		}

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming a tool activates it even when it is not active by default; a hidden tool never is.
				if (allowedToolNames.has(toolName) && this._getToolExposure(toolName) !== "hidden") {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (isDirectlyExposed(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName) && isDirectlyExposed(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	/**
	 * Arm the tool barrier (senpi#3717): until `releaseToolBarrier(id)`, the end of the turn it was armed for,
	 * or `deadlineMs`, every tool not declared `workspaceEffect: "read"` waits before it runs.
	 */
	armToolBarrier(spec: ToolBarrierSpec): void {
		const error = toolBarrierSpecError(spec);
		if (error !== undefined) throw new Error(error);
		this._toolBarrier.arm(spec);
	}

	/** Open the barrier armed under `id`; false (a no-op) when no barrier with that id is armed. */
	releaseToolBarrier(id: string): boolean {
		return this._toolBarrier.release(id);
	}

	/** Hold a workspace-changing call while a tool barrier is armed; true when it waited. */
	private async _waitForToolBarrier(toolCall: AgentToolCall, signal: AbortSignal | undefined): Promise<boolean> {
		if (this._toolDefinitions.get(toolCall.name)?.definition.workspaceEffect === "read") return false;
		const wait = this._toolBarrier.wait(signal);
		if (!wait) return false;
		this._emit({ type: "tool_barrier_waiting", id: wait.id, toolCallId: toolCall.id, toolName: toolCall.name });
		await wait.done;
		return true;
	}

	/** Normalized exposure of a registered tool (C-EX-1); a name without a definition is `direct`. */
	private _getToolExposure(name: string): ToolExposure {
		const entry = this._toolDefinitions.get(name);
		return entry ? normalizeToolExposure(entry.definition).exposure : "direct";
	}

	/**
	 * Whether registering the tool activates it: `direct`, `eval` and `model-only` tools, unless the
	 * definition sets `defaultActive: false`. `search` tools activate lazily; `hidden` tools never do.
	 */
	private _isActivatedOnRegistration(name: string): boolean {
		const entry = this._toolDefinitions.get(name);
		if (!entry) return false;
		const exposure = normalizeToolExposure(entry.definition).exposure;
		return (
			(exposure === "direct" || exposure === "eval" || exposure === "model-only") &&
			entry.definition.defaultActive !== false
		);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
		previousActiveToolRegistrationIds?: ReadonlyMap<string, string>;
		addedToolNames?: readonly string[];
	}): void {
		this._delegatedCompactionKey = undefined;
		this._lazyToolActivation.reset();
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const extensionsResult = this._resourceLoader.getExtensions();
		const filesystemPolicy = composeFilesystemPolicies(
			extensionsResult.extensions.flatMap((extension) => extension.filesystemPolicies ?? []),
		);
		this._filesystemPolicy = filesystemPolicy;
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages, filesystemPolicy },
					// The core bash tool's process work goes through the dispatcher's operations: the same
					// local operations under in-process, and the tool child's user.bash job under child
					// (senpi#3566 todo 9), while truncation and rendering stay on the server.
					bash: {
						commandPrefix: shellCommandPrefix,
						redactSecretsInOutput: this.settingsManager.getBashRedactSecretsInOutput(),
						shellPath,
						operations: this._toolDispatcher.bashOperations({ shellPath }),
					},
					write: { filesystemPolicy },
					edit: { filesystemPolicy },
					grep: { filesystemPolicy },
					find: { filesystemPolicy },
					glob: { filesystemPolicy },
					ls: { filesystemPolicy },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
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
			extensionsResult.eventBus,
		);
		this._adoptToolSearchService(extensionsResult.runtime);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write", "grep"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
			previousActiveToolRegistrationIds: options.previousActiveToolRegistrationIds,
			addedToolNames: options.addedToolNames,
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
		if (this._promptStartPending) return this.checkReloadVeto();
		// Prompts admitted from here on wait for the rebuilt runtime instead of starting on the retiring one.
		const finishReloadWork = this._sessionWorkBarrier.begin();
		try {
			return await this._rebuildRuntimeForReload(options);
		} finally {
			finishReloadWork();
		}
	}

	/**
	 * Loads or unloads the project's code after the session's project trust changed (Full access left or
	 * re-entered, senpi#3420): rebuilds the runtime exactly like reload(), but nothing can cancel it. No
	 * `session_before_reload` handler runs (a project extension must not keep itself loaded); a prompt
	 * that is being admitted, or a session start in dispatch, is waited out instead of cancelling, and
	 * prompts admitted after that wait for the rebuilt runtime. A reload already in flight sees the trust
	 * epoch move and loads again before it installs anything.
	 */
	async applyProjectTrustChange(): Promise<void> {
		while (this._promptStartPending || this._sessionStartDispatching) {
			await new Promise<void>((resolve) => this._admissionIdleWaiters.push(resolve));
		}
		const finishReloadWork = this._sessionWorkBarrier.begin();
		try {
			await this._rebuildRuntimeForReload();
		} finally {
			finishReloadWork();
		}
	}

	private _notifyAdmissionIdle(): void {
		if (this._promptStartPending || this._sessionStartDispatching) return;
		const waiters = this._admissionIdleWaiters;
		this._admissionIdleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private async _rebuildRuntimeForReload(options?: {
		beforeSessionStart?: () => void | Promise<void>;
	}): Promise<{ cancelled: false }> {
		resetTimings("reload");
		const oldExtensionRunner = this._extensionRunner;
		const oldSessionControl = this._sessionControl;
		const oldExtensionIdentities = oldExtensionRunner.getExtensionIdentities();
		const previousActiveToolRegistrationIds = new Map<string, string>();
		// Cover withheld eval-only tools too: the rebuild drops any seeded name missing from this
		// map, which would strand eval-only tools when the policy disarms during this reload.
		for (const name of this._requestedActiveToolNames ?? this.getActiveToolNames()) {
			const entry = this._toolDefinitions.get(name);
			if (entry) previousActiveToolRegistrationIds.set(name, deriveExtensionRegistrationId(entry.sourceInfo, name));
		}
		await emitSessionShutdownEvent(oldExtensionRunner, {
			type: "session_shutdown",
			reason: "reload",
		});
		time("shutdown", "reload");
		const previousDefaultTools = new Set(
			this._usesDefaultTools ? (this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES) : [],
		);
		let trustEpoch = this.settingsManager.getTrustEpoch();
		await this.settingsManager.reload();
		this._delegatedCompactionKey = undefined;
		// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
		// during the session stay disabled unless the setting newly adds them.
		const currentDefaultTools = this._usesDefaultTools
			? (this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES)
			: [];
		const addedDefaultTools = currentDefaultTools.filter((name) => !previousDefaultTools.has(name));
		// Builtin extension tools are registered only when configured; a newly added one must pass that filter.
		if (this._defaultToolNames && addedDefaultTools.length > 0) {
			this._defaultToolNames = new Set([...this._defaultToolNames, ...addedDefaultTools]);
		}
		// Capture the unfiltered request BEFORE the rebuild reassigns it, so a policy that
		// disarms during this reload can still restore its withheld eval-only tools.
		const requestedActiveToolNamesBeforeRebuild = [...(this._requestedActiveToolNames ?? this.getActiveToolNames())];
		// Re-resolve fixed and declared policy (or SDK override); the registry rebuild refreshes declarations again.
		this._evalOnlyToolNames = this._resolveEvalOnlyToolNames();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		time("settings", "reload");
		await this._modelRuntime.reloadConfig();
		// Resolving both scopes from the completed refresh avoids two extra availability
		// scans, but only a snapshot from a SUCCESSFUL refresh may be trusted: refresh()
		// swallows availability errors, so a failed scan must fall back to the runtime and
		// keep the previous refresh-and-surface-the-error behavior.
		const refreshedModels: AvailableModelsSource = this._modelRuntime.hasFreshAvailabilitySnapshot()
			? {
					getAvailable: async () => this._modelRuntime.getAvailableSnapshot(),
				}
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
		await this._resourceLoader.reload({
			settingsAlreadyReloadedFor: this.settingsManager,
		});
		// The project trust changed while this rebuild ran (senpi#3420): what it loaded matches the old
		// trust, so it loads again under the current one. Nothing is installed until a load matches the
		// trust at install time; the check and the install below run in one synchronous step.
		while (this.settingsManager.getTrustEpoch() !== trustEpoch) {
			trustEpoch = this.settingsManager.getTrustEpoch();
			await this.settingsManager.reload();
			await this._resourceLoader.reload({ settingsAlreadyReloadedFor: this.settingsManager });
		}
		time("resources", "reload");
		this.securityNotices.setResources(this._resourceLoader.getSkills().diagnostics);
		try {
			this._buildRuntime({
				activeToolNames: requestedActiveToolNamesBeforeRebuild,
				// Read from the CURRENT runner at the swap, not before the awaits above and not from the
				// runner this reload started with: a flag set while this reload ran (an attach moving the
				// session's permission preset) carries over, also when an overlapping reload installed
				// another runner in the meantime and the attach wrote that one (senpi#2842).
				flagValues: this._extensionRunner.getFlagValues(),
				includeAllExtensionTools: true,
				previousActiveToolRegistrationIds,
				addedToolNames: addedDefaultTools,
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
			try {
				if (removed.length > 0) {
					await oldExtensionRunner.emit({
						type: "session_extensions_removed",
						reason: "reload",
						removed,
					});
				}
			} finally {
				// The control endpoints the retiring generation registered drain through its closures:
				// they go with it, before anything can wake them on the retired runner (senpi#3246).
				await oldSessionControl?.retire().catch((error: unknown) => {
					this._extensionRunner.emitError({
						extensionPath: "<session-control>",
						event: "reload",
						error: error instanceof Error ? error.message : String(error),
					});
				});
				oldExtensionRunner.invalidate("stale extension generation after reload");
			}
			time("runtime", "reload");
		}

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			const settleSessionStart = this._beginSessionStartSettlement();
			this._sessionStartDispatching = true;
			try {
				await options?.beforeSessionStart?.();
				this.syncPromptCacheSafeWaitEnv();
				await this._extensionRunner.emit({
					type: "session_start",
					reason: "reload",
				});
				await this.extendResourcesFromExtensions("reload");
			} finally {
				this._sessionStartDispatching = false;
				settleSessionStart();
				this._notifyAdmissionIdle();
			}
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
		return checkSessionReloadVeto(
			this._extensionRunner,
			() => this._promptStartPending,
			() => this._sessionStartDispatching,
		);
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
		if (this._isLocalFailure(message)) return false;
		// A route that does not serve the model fails the same way on every attempt, whatever status wraps it.
		if (isModelConfigFailure(message)) return false;

		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;

		if (isClassifierRefusal(message)) return true;
		if (!message.errorMessage) return false;

		if (message.stopReason === "aborted") {
			return isProviderTimeoutError(message);
		}

		return isRetryableAssistantError(message);
	}

	/**
	 * A failure the agent marked local (the session's journal or file, senpi#3866). The mark is typed and set by
	 * where the error came from, never read from its text: the text carries the OS error, which can read like a
	 * provider quota (EDQUOT). No model produced it, so it never retries, walks the fallback chain, or marks a
	 * model unhealthy.
	 */
	private _isLocalFailure(message: AssistantMessage): boolean {
		return message.failureSource === "local";
	}

	private _isCursorPayloadOverflow(message: AssistantMessage): boolean {
		return isCursorPayloadResourceExhausted(message, 0);
	}

	private _truncateAgentMessagesToLastUserTurn(): boolean {
		const messages = this.agent?.state?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return false;
		let lastUser = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "user") {
				lastUser = i;
				break;
			}
		}
		if (lastUser <= 0) return false;
		this.agent.state.messages = messages.slice(lastUser);
		return true;
	}

	private _isClaudeSdkSessionLockError(message: AssistantMessage): boolean {
		return (message.errorMessage ?? "").includes("Lock file is already being held");
	}

	private _isClaudeSdkInvalidRequestError(message: AssistantMessage): boolean {
		return message.errorMessage === "invalid_request";
	}

	/**
	 * Claude-SDK-only quirks that a provider hop cannot fix: the session.json
	 * lock is held by this session's own subprocess, and a bare `invalid_request`
	 * from the SDK boundary carries no provider-neutral meaning. Both are scoped
	 * to the Claude SDK lane, because the SAME wording from another provider is
	 * an ordinary failure whose classification (transient retry, or hard-error
	 * fallback) must not change. Provider-agnostic classes - the stream-stall
	 * watchdog above all - stay out of this predicate: they already consume the
	 * shared same-model budget through `isRetryableAssistantError` and must still
	 * escalate to the fallback chain when that budget runs out.
	 */
	private _isClaudeSdkSameModelRemintError(message: AssistantMessage): boolean {
		if (this.model?.provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) return false;
		return this._isClaudeSdkSessionLockError(message) || this._isClaudeSdkInvalidRequestError(message);
	}

	/**
	 * The Claude SDK lane owns its own account pool: an auth miss there is
	 * repaired or failed over inside the pool, so hopping to another provider
	 * would abandon the user's Claude subscription on a recoverable miss. Every
	 * other provider keeps the configured fallback-chain hop. The sign-in-again
	 * prompt (senpi#4436) is the same kind of miss: every model on the lane fails
	 * it until the user signs in, so it neither retries nor hops.
	 */
	private _isClaudeSdkAuthMissError(message: AssistantMessage): boolean {
		return (
			this.model?.provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID &&
			(message.errorMessage === providerNotConfiguredMessage(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) ||
				isSignInAgainError(message.errorMessage))
		);
	}

	private _isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		return (
			!message.errorMessage?.startsWith(TURN_RETRY_SUPPRESSION_PREFIX) &&
			!this._isLocalFailure(message) &&
			!isModelConfigFailure(message) &&
			!this._isClaudeSdkAuthMissError(message) &&
			!this._isClaudeSdkSameModelRemintError(message) &&
			message.stopReason === "error" &&
			!isContextOverflow(message, this.model?.contextWindow ?? 0) &&
			this._requestShapeRecovery.decide(message, this.model?.contextWindow ?? 0) === "not-request-shape" &&
			!this._isCursorPayloadOverflow(message) &&
			!isCursorZeroTokenResourceExhausted(message) &&
			!isClassifierRefusal(message) &&
			!message.content.some((content) => content.type === "toolCall") &&
			this._retryFallback.canTryFallback(isRequestLevelRefusal(message) ? message.provider : undefined)
		);
	}

	/** Same-model recovery for a request-shape 400: never a model switch (senpi#3727). */
	private async _handleRequestShapeRejection(
		message: AssistantMessage,
		decision: "recover" | "give-up",
	): Promise<"continued" | "blocked" | "not-handled" | "cancelled"> {
		if (decision === "give-up") {
			this._requestShapeRecovery.endStreak();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: Math.max(1, this._retryAttempt),
				finalError: REQUEST_SHAPE_FAILURE_TEXT,
			});
			this._retryAttempt = 0;
			return "not-handled";
		}
		this._requestShapeRecovery.begin(message.timestamp);
		this._emitEntryAppended(
			this.sessionManager.appendCustomEntry(REQUEST_SHAPE_RECOVERY_ENTRY_TYPE, {
				note: REQUEST_SHAPE_RECOVERY_NOTE,
				model: message.model,
			}),
		);
		this._sessionLogger.info("request_shape_recovery", { provider: message.provider, model: message.model });
		this._retryAttempt = 0;
		return await this._handleRetryableError(
			{ ...message, errorMessage: REQUEST_SHAPE_RECOVERY_NOTE },
			{ sameModelRemint: true },
		);
	}

	private _takeNativeToolSearchInjectionFailure(): string | null {
		return this._toolSearchService?.takeNativeInjectionFailure() ?? null;
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

	private _compactionFailureModel(): string | undefined {
		return this.model ? `${this.model.provider}/${this.model.id}` : undefined;
	}

	/**
	 * User-facing text for a turn that is really over. A provider-stream stall
	 * or a transport drop carries the classifier's own wording (`Provider stream
	 * start timed out after 180000ms ...`, `WebSocket closed 1006 ...`), which
	 * the retry engine needs on the message but which explains nothing to the
	 * person reading the transcript and names no next step (senpi#1740,
	 * senpi#1628). Anything else keeps its error verbatim, minus the internal
	 * replay marker.
	 */
	private _terminalFailureText(message: AssistantMessage, attempts: number): string | undefined {
		const model = this.model ? `${this.model.provider}/${this.model.id}` : undefined;
		return (
			describeProviderFailureForUser(message.errorMessage, {
				attempts,
				model,
				usageLimit: usageLimitScope(message.errorMessage),
				recovery: this._retryFallback.hasConfiguredChain() ? "chain-exhausted" : "no-fallback-configured",
			}) ?? (message.errorMessage === undefined ? undefined : stripTurnRetrySuppressionPrefix(message.errorMessage))
		);
	}

	/**
	 * A 429-class failure with no usable fallback candidate must not fail the
	 * turn with zero attempts: a provider answering 429 is asking for a retry.
	 * No-hint and tier2 waits degrade to same-model in-turn retries under the
	 * normal retry budget (tier2 clamps the hinted wait to the in-turn cap);
	 * only tier3 hour-plus waits stay terminal, with the requested wait named
	 * in the final error. Returns the in-turn retry delay, or undefined after
	 * emitting the terminal auto_retry_end.
	 */
	private _degradeRateLimitedWithoutFallback(
		tier: HintTier,
		hintMs: number | undefined,
		message: AssistantMessage,
		errorMessage: string,
	): number | undefined {
		const settings = this.settingsManager.getRetrySettings();
		// Budget checks use the resolved profile (same value as settings.maxRetries
		// for providers without a declared profile).
		const turnMaxRetries = this._resolveRetryProfile().turn.maxRetries;
		const hintSettings = this.settingsManager.getHintPolicySettings();
		const finishRetryAttempt = (attempt: number, finalError: string | undefined) => {
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
				attempt,
				finalError,
			});
			this._retryAttempt = 0;
			this._resetHintTierState();
			this._resolveRetry();
		};
		const degraded = degradeWithoutFallback(
			tier,
			hintMs,
			this._retryAttempt + 1,
			settings.baseDelayMs,
			hintSettings.hintedWaitCapMs,
		);
		if (degraded.kind === "fail") {
			const waitSeconds = Math.ceil(degraded.hintMs / 1000);
			const until = new Date(Date.now() + degraded.hintMs).toLocaleString("en-US", {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				timeZoneName: "short",
			});
			finishRetryAttempt(
				this._retryAttempt,
				`The provider asked to wait ${waitSeconds}s (until ${until}) before the next request, and no fallback model can take the turn. Wait until then, or choose another model. Provider error: ${message.errorMessage ?? "none"}`,
			);
			return undefined;
		}
		this._retryAttempt++;
		if (this._retryAttempt > turnMaxRetries) {
			finishRetryAttempt(this._retryAttempt - 1, message.errorMessage);
			return undefined;
		}
		return degraded.delayMs;
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns whether retry continuation started, was blocked by compaction, or was not handled
	 */
	private async _handleRetryableError(
		message: AssistantMessage,
		options: { hardErrorFallback?: boolean; sameModelRemint?: boolean } = {},
	): Promise<"continued" | "blocked" | "not-handled" | "cancelled"> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this._resolveRetry();
			return "not-handled";
		}

		// Resolve the effective retry profile for the current provider.
		// Profile-driven behaviour only diverges when a provider declares one;
		// the senpi-default profile preserves today's tier routing exactly.
		const retryProfile = this._resolveRetryProfile();

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
		const sameModelRemint = options.sameModelRemint === true;
		let switchedFallback = false;
		let sameModelNativeRecovery = false;
		let is429TierRouted = false;
		let hintTierDelayMs: number | undefined;
		const tryFallback = async (
			reason: Parameters<typeof this._retryFallback.tryFallback>[0],
			failure: Parameters<typeof this._retryFallback.tryFallback>[1],
		) => {
			try {
				return await this._retryFallback.tryFallback(reason, failure);
			} catch (error) {
				if (error instanceof ModelUsabilityBudgetError) {
					this._resolveRetry();
					return false;
				}
				throw error;
			}
		};
		if (usageLimitScope(errorMessage) === "account") {
			switchedFallback = await tryFallback(isBillingErrorMessage(errorMessage) ? "billing" : "transient", {
				errorMessage,
				retryAfterMs: this._getProviderRetryDelayMs(errorMessage),
			});
			if (!switchedFallback) {
				const chainKey = this._retryFallback.exhaustedChainKey;
				if (chainKey) this._emit({ type: "retry_fallback_exhausted", chainKey, lastError: errorMessage });
				if (this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: false,
						attempt: this._retryAttempt,
						finalError: this._terminalFailureText(message, this._retryAttempt),
					});
				}
				this._retryAttempt = 0;
				this._resetHintTierState();
				this._resolveRetry();
				return "not-handled";
			}
			this._retryAttempt = 1;
		} else if (sameModelRemint) {
			this._retryAttempt++;
			if (this._retryAttempt > retryProfile.turn.maxRetries) {
				if (this._retryAttempt > 1) {
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
		} else if (hardErrorFallback) {
			// A rejected native tool-search request is recoverable in place: the
			// adapter is disabled for the session on the 400, so the SAME model can
			// succeed on the immediate next attempt and the fallback chain must not
			// demote the user to a weaker model. The pending flag is consumed once,
			// so a second rejection takes the ordinary hard-error path below.
			const nativeSearchFailure = this._takeNativeToolSearchInjectionFailure();
			if (nativeSearchFailure !== null) {
				sameModelNativeRecovery = true;
				// The recovery starts fresh, mirroring the fallback branch's attempt bookkeeping.
				this._retryAttempt = 1;
			} else {
				// A non-retryable provider failure must never replay on the same model.
				// Billing-class failures never recover on this account, so the fallback
				// switch pins as the session model instead of reverting after the cooldown.
				const reason = isBillingErrorMessage(errorMessage) ? "billing" : "hard-error";
				switchedFallback = await tryFallback(reason, {
					errorMessage,
					...(isRequestLevelRefusal(message) ? { refusedProvider: message.provider } : {}),
				});
				if (!switchedFallback) {
					const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
					if (exhaustedChainKey) {
						this._emit({
							type: "retry_fallback_exhausted",
							chainKey: exhaustedChainKey,
							lastError: errorMessage,
						});
					}
					this._resolveRetry();
					return "not-handled";
				}
				// The fallback starts fresh; the failed model's transient attempts do not carry over.
				this._retryAttempt = 1;
			}
		} else if (isRefusal) {
			// Refusals are only retried through a new chain candidate. They never use
			// same-model retries or the transient over-budget fallback escape hatch.
			if (this._retryAttempt + 1 > retryProfile.turn.maxRetries) {
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
			switchedFallback = await tryFallback("refusal", {});
			if (!switchedFallback) {
				const exhaustedChainKey = this._retryFallback.exhaustedChainKey;
				if (exhaustedChainKey) {
					this._emit({
						type: "retry_fallback_exhausted",
						chainKey: exhaustedChainKey,
						lastError: errorMessage,
					});
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
		} else if (this._isCircuitProbeOnCurrentModel() && this._retryFallback.canTryFallback()) {
			// A half-open probe proves nothing by retrying: its first provider-health
			// failure reopens the circuit and moves on instead of spending the budget.
			switchedFallback = await tryFallback("transient", {
				errorMessage,
				retryAfterMs: this._getProviderRetryDelayMs(errorMessage),
			});
			if (!switchedFallback) {
				this._resolveRetry();
				return "not-handled";
			}
			this._retryAttempt = 1;
		} else {
			// A provider-stream stall is an ordinary transient failure: it consumes
			// the same bounded same-model budget (the resolved profile's turn
			// maxRetries) as every other retryable class and escalates to the fallback chain only when
			// that budget is exhausted. It is excluded from 429-class tier routing
			// because a stall carries no rate-limit markers or retry-after hint.
			const stallError = isProviderStreamStallError(message);
			// 429-class detection: retryable AND message carries rate-limit markers.
			// Every same-model wait derived below is floored by the exponential schedule
			// inside the pure hint policy, so repeated tiny retry-after hints cannot pin
			// the cadence at a few milliseconds. Do not recompute that floor here.
			const is429Class =
				!stallError &&
				/rate.?limit|(?:^429(?=\s+\{)|(?:\bHTTP\/1\.[01]\s+|\bHTTP\s+|\bstatus(?:\s+code)?\s+|\berror\s+|\bcode\s+)429\b)|too many requests|resource.?exhausted/i.test(
					errorMessage,
				);
			// Profile-driven routing: "after-turn-budget" (Kimi) keeps 429s on the
			// ordinary same-model budget; "tiered" (senpi default) uses hint tiers.
			if (is429Class && retryProfile.fallback.rateLimited === "after-turn-budget") {
				// Kimi profile: 429s consume the same-model budget like any transient.
				// Mark tier-routed so the generic non-429 path below does not double-count.
				is429TierRouted = true;
				this._retryAttempt++;
				if (this._retryAttempt > retryProfile.turn.maxRetries) {
					switchedFallback = await tryFallback("transient", {
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
				}
			} else if (is429Class) {
				const hintMs = this._getProviderRetryDelayMs(errorMessage);
				const hintSettings = this.settingsManager.getHintPolicySettings();
				const tier = classifyRateLimitedWait(hintMs, hintSettings);
				is429TierRouted = true;
				if (tier === "no-hint-fast-fallback") {
					// Fall back immediately when a candidate exists; otherwise degrade
					// to same-model in-turn retries instead of failing the turn.
					switchedFallback = await tryFallback("transient", { errorMessage });
					if (switchedFallback) {
						this._retryAttempt = 1;
					} else {
						const degradedDelayMs = this._degradeRateLimitedWithoutFallback(tier, hintMs, message, errorMessage);
						if (degradedDelayMs === undefined) return "not-handled";
						hintTierDelayMs = degradedDelayMs;
					}
				} else if (tier === "tier1-in-turn") {
					this._retryAttempt++;
					if (this._retryAttempt > retryProfile.turn.maxRetries) {
						// Budget exhausted within tier1; fall back.
						switchedFallback = await tryFallback("transient", {
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
							switchedFallback = await tryFallback("transient", {
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
					switchedFallback = await tryFallback("transient", {
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
						const degradedDelayMs = this._degradeRateLimitedWithoutFallback(tier, hintMs, message, errorMessage);
						if (degradedDelayMs === undefined) return "not-handled";
						hintTierDelayMs = degradedDelayMs;
					}
				}
			}
			if (!is429TierRouted) {
				this._retryAttempt++;
			}
			if (!is429TierRouted && this._retryAttempt > retryProfile.turn.maxRetries) {
				switchedFallback = await tryFallback("transient", {
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
						finalError: this._terminalFailureText(message, this._retryAttempt - 1),
					});
					this._retryAttempt = 0;
					this._resetHintTierState();
					this._resolveRetry();
					return "not-handled";
				}
			}
		}

		const providerDelayMs = isRefusal || hardErrorFallback ? undefined : this._getProviderRetryDelayMs(errorMessage);
		const maxRetryDelayMs = this.settingsManager.getProviderRetrySettings().maxRetryDelayMs;
		// Profile ceiling null (Kimi) bypasses the over-ceiling error path entirely.
		const profileCeiling =
			retryProfile.turn.serverHint.mode === "override"
				? retryProfile.turn.serverHint.ceiling.maxDelayMs
				: maxRetryDelayMs;
		const effectiveMaxRetryDelayMs = profileCeiling ?? Number.MAX_SAFE_INTEGER;
		// For 429-class failures the tier routing replaces the over-budget gate.
		if (!is429TierRouted && providerDelayMs !== undefined && providerDelayMs > effectiveMaxRetryDelayMs) {
			// A wait this long means the model is unavailable rather than busy, so the
			// configured chain beats failing the turn. The switch is gated: the over-budget
			// branch above may have already switched on this same error, and hopping again
			// here would skip that candidate's own retry budget.
			if (!switchedFallback) {
				switchedFallback = await tryFallback("transient", {
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
		// 429-tier delays already carry the exponential floor from nextInTurnDelayMs /
		// degradeWithoutFallback; the non-tier branch keeps its own exponential fallback.
		const nonTierProviderDelayMs = providerDelayMs === 0 ? undefined : providerDelayMs;
		// Locally computed exponential goes through the profile's backoff policy
		// (cap + jitter), sampled through the injectable retryRandom seam so tests
		// stay deterministic; provider-derived hints on the non-429 path remain
		// authoritative and fallback switches stay exact.
		const localExponentialMs = retryBackoffDelayMs(
			retryProfile.turn.backoff,
			this._retryAttempt,
			this._retryRandom(),
		);
		const plannedDelayMs =
			switchedFallback || sameModelNativeRecovery
				? 0
				: is429TierRouted
					? (hintTierDelayMs ?? providerDelayMs ?? localExponentialMs)
					: (nonTierProviderDelayMs ?? localExponentialMs);
		// `retry.maxAgentDelayMs` is a hard ceiling on ONE agent-level wait, applied after
		// the profile/hint/jitter planning above (the planner still owns the schedule).
		// It bounds the worst case a provider hint or a long backoff can impose on a turn.
		// A profile's override-mode turn hint ceiling owns this clamp instead of the
		// settings default (fork semantics: the ceiling belongs to the profile, and an
		// explicit profile ceiling must not be clamped by the global default): `null`
		// (kimi-code) is explicitly uncapped, so a wait the over-ceiling gate above
		// admitted passes through verbatim; a number is the profile's own cap. The
		// settings cap applies only when the profile declares no ceiling of its own
		// (the tiered senpi-default).
		const profileTurnCeilingMs =
			retryProfile.turn.serverHint.mode === "override" ? retryProfile.turn.serverHint.ceiling.maxDelayMs : undefined;
		// An explicitly user-configured retry.maxAgentDelayMs always wins; a profile's own
		// ceiling is the next authority; the 60s default is the last resort.
		const userConfiguredCeilingMs = this.settingsManager.isRetryMaxAgentDelayMsConfigured?.() ?? false;
		const agentCeilingMs = userConfiguredCeilingMs
			? settings.maxAgentDelayMs
			: profileTurnCeilingMs === undefined
				? settings.maxAgentDelayMs
				: profileTurnCeilingMs;
		const delayMs = Math.min(plannedDelayMs, agentCeilingMs ?? Number.MAX_SAFE_INTEGER);
		// Prepare before auto_retry_start so an immediate Esc can cancel the retry sleep.
		this._retryAbortController = new AbortController();

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: retryProfile.turn.maxRetries,
			delayMs,
			errorMessage:
				usageLimitScope(errorMessage) === "account"
					? new AccountUsageLimitError(message.provider, errorMessage).message
					: errorMessage,
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
			return "cancelled";
		}
		this._retryAbortController = undefined;

		// Turn boundary: a suppression that expired during the backoff sleep lets
		// the retry continue on the restored primary instead of the fallback model.
		await this._maybeRestoreFallbackPrimary("continuation");

		// Model fallback (or reversion) can select a smaller context window after
		// the prior retry checks. Revalidate canonical session context immediately
		// before the continuation so a rejected compaction never admits that model.
		const model = this.model;
		const compactionSettings = this._getCompactionSettings();
		const contextTokens = this._estimatePrePromptContextTokens();
		if (
			compactionSettings.enabled &&
			model &&
			shouldCompact(contextTokens, model.contextWindow, compactionSettings)
		) {
			const preRetryCompaction = await this._runPrePromptCompaction(message, true, "threshold", true, true);
			if (
				!preRetryCompaction &&
				!this._isCompactionOnCooldown() &&
				!this._isCompactionDelegated() &&
				!this._hasSupersedingCompactionClaim()
			) {
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
		if (continuation.options.deferQueuedMessages === true) {
			DEFERRED_RETRY_QUEUE_OWNERS.add(this);
		} else {
			DEFERRED_RETRY_QUEUE_OWNERS.delete(this);
		}
		this.agent.suppressQueuedMessageDrain();
		// A virtual selection routes the retry with the failed response, which the context no longer holds.
		this._failedResponse = message;
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
		options?: {
			excludeFromContext?: boolean;
			id?: string;
			operations?: BashOperations;
		},
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);
		this.refreshLifecycle();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? this._toolDispatcher.bashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						const callbackResult = onChunk?.(delta);
						this._emit({
							type: "bash_execution_update",
							id: options?.id,
							delta,
						});
						return callbackResult;
					},
					signal: abortController.signal,
					redactSecretsInOutput: this.settingsManager.getBashRedactSecretsInOutput(),
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
			this.refreshLifecycle();
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

	/** Remove a host-owned full-output spill after a remote observer failed. */
	async cleanupBashOutput(path: string): Promise<void> {
		await rm(path, { force: true });
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
		const event = {
			type: "session_info_changed",
			name: this.sessionManager.getSessionName(),
		} as const;
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
	 * @param options.intent Select for retry (default), or resume the exact entry without editor text
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: TreeNavigationOptions = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		return this._navigateTree(targetId, options);
	}

	/**
	 * Start a turn from the current leaf with no new user prompt (senpi #1930): after an edited
	 * assistant response becomes the leaf, the model continues from its edited text, delivered as a
	 * hidden custom message, never as a trailing assistant message (see continue-from-leaf.ts).
	 * Resolves once the runtime took the continuation (its `agent_start`, or a delegated queue into
	 * a running turn), like a prompt - NOT after the whole continued turn. Before this it awaited
	 * the whole turn, so a desktop continuation longer than the RPC control deadline always timed
	 * out (#848 / senpi #2708). Refuses while streaming and on a session with no messages. The turn
	 * keeps running in the background after this resolves; a later failure reaches the client as its
	 * normal turn error event, not as a reply here.
	 */
	async continueFromLeaf(): Promise<void> {
		if (this.isStreaming) throw new ContinueFromLeafError("streaming");
		if (this.agent.state.messages.length === 0) throw new ContinueFromLeafError("nothing_to_continue");
		// Only an answer can be continued; a prompt left as the leaf (an edited one) is retried, not continued.
		const leaf = this.agent.state.messages[this.agent.state.messages.length - 1];
		if (leaf?.role !== "assistant") throw new ContinueFromLeafError("leaf_not_assistant");
		const turnClaim = new DeferredTurnClaim();
		const admission = trackTurnAdmission({
			disposition: turnClaim.disposition,
			subscribe: (listener) =>
				this.subscribe((event) => {
					if (event.type === "agent_start") listener({ type: "agent_start" });
				}),
		});
		// The turn runs in the background. trackTurnAdmission resolves at admission;
		// a start-time failure in sendCustomMessage rejects the race, so the client
		// sees the same error a prompt-start failure would give, not a false "started".
		const run = this.sendCustomMessage(
			{
				customType: CONTINUE_FROM_LEAF_CUSTOM_TYPE,
				content: CONTINUE_FROM_LEAF_DIRECTIVE,
				display: false,
			},
			{ triggerTurn: true },
			turnClaim,
		);
		try {
			await Promise.race([admission.promise, run]);
		} finally {
			admission.dispose();
		}
		// After admission the turn runs detached; a later failure is a normal turn
		// error event, not this reply. Swallow it here so it is not an unhandled
		// rejection; the client observes it through the turn stream like any prompt.
		run.catch(() => undefined);
	}

	/**
	 * Replace an assistant response with an edited copy. The leaf moves to the target's parent and
	 * the edited message is appended there as the new leaf, so the original and everything after it
	 * are abandoned exactly like a tree navigation (branch summary optional, `session_before_tree`
	 * and `session_tree` fire). Unchanged text appends nothing.
	 */
	async editAssistantMessage(
		entryId: string,
		text: string,
		options: TreeNavigationOptions = {},
	): Promise<AssistantEditResult> {
		if (this.isStreaming) {
			throw new SessionStreamingError();
		}
		// Stale tokens fail before the unchanged short-circuit: a stale window never learns "unchanged".
		assertExpectedLeaf(options.expectedLeafId, lifecycleEditLeaf(this.sessionManager, options.expectedLeafId));
		const targetEntry = this.sessionManager.getEntry(entryId);
		if (!targetEntry) {
			throw new AssistantEditError("not-found", `Entry ${entryId} not found`);
		}
		if (targetEntry.type !== "message" || targetEntry.message.role !== "assistant") {
			throw new AssistantEditError("not-assistant", `Entry ${entryId} is not an assistant message`);
		}
		// Build first so an empty replacement is rejected even when the original carries no text.
		const replacement = buildEditedAssistantMessage(targetEntry.message, text);
		if (assistantTextEquals(targetEntry.message, text)) {
			return { cancelled: false, unchanged: true };
		}
		return this._navigateTree(entryId, options, replacement);
	}

	/**
	 * Replace a prompt with an edited copy. The leaf moves to the target's parent and the edited
	 * prompt is appended there as the new leaf, so the original and everything after it are
	 * abandoned exactly like a tree navigation - this is the `/tree` selection rule of
	 * `docs/sessions.md`, with the edited text written into the session instead of into an editor.
	 * No turn starts: the new leaf is a prompt with no reply until a caller runs one. Unchanged
	 * text appends nothing.
	 */
	async editUserMessage(entryId: string, text: string, options: TreeNavigationOptions = {}): Promise<UserEditResult> {
		if (this.isStreaming) {
			throw new SessionStreamingError();
		}
		// Stale tokens fail before the unchanged short-circuit: a stale window never learns "unchanged".
		// `_navigateTree` re-checks the same token; nothing awaits in between, so the two agree.
		assertExpectedUserLeaf(options.expectedLeafId, lifecycleEditLeaf(this.sessionManager, options.expectedLeafId));
		const targetEntry = this.sessionManager.getEntry(entryId);
		if (!targetEntry) {
			throw new UserEditError("not-found", `Entry ${entryId} not found`);
		}
		if (targetEntry.type !== "message" || targetEntry.message.role !== "user") {
			throw new UserEditError("not-user", `Entry ${entryId} is not a user message`);
		}
		// Build first so an empty replacement is rejected even when the original carries no text.
		const replacement = buildEditedUserMessage(targetEntry.message, text);
		if (userTextEquals(targetEntry.message, text)) {
			return { cancelled: false, unchanged: true };
		}
		return this._navigateTree(entryId, options, replacement);
	}

	private async _navigateTree(
		targetId: string,
		options: TreeNavigationOptions,
		replacement?: AssistantMessage | UserMessage,
	): Promise<AssistantEditResult> {
		if (this.isStreaming) {
			throw new SessionStreamingError();
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();
		// Stale tokens fail even for a would-be no-op, before any extension hears about the navigation.
		assertExpectedLeaf(options.expectedLeafId, lifecycleEditLeaf(this.sessionManager, options.expectedLeafId));

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new AssistantEditError("not-found", `Entry ${targetId} not found`);
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
		// The navigation is session work: a prompt, a scheduled tick or a triggered delivery that arrives while it runs
		// (a branch summary is a model call) waits for it, instead of starting a run on the leaf it is moving (senpi#4154).
		const finishSessionWork = this._sessionWorkBarrier.begin();

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
				const {
					model: requestModel,
					apiKey,
					headers,
					extraBody,
					env,
				} = await this._getCompactionRequestAuth(model, this._branchSummaryAbortController.signal);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
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
					callbacks: this._summarizationRetryCallbacks({
						source: "branchSummary",
					}),
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

			// Determine the new leaf position based on intent and target type.
			// Message edits keep their replacement semantics regardless of navigation-only options.
			const resume = options.intent === "resume" && !replacement;
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (replacement) {
				// Edited message (assistant or user): leaf = parent, the edited copy is appended below.
				// A user target keeps no editorText: its text is written into the session, not an editor.
				newLeafId = targetEntry.parentId;
			} else if (resume) {
				// Exact branch resumption never selects a prompt for editing, whatever its role.
				newLeafId = targetId;
			} else if (targetEntry.type === "message" && targetEntry.message.role === "user") {
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

			const editedEntryId = replacement ? this.sessionManager.appendMessage(replacement) : undefined;
			if (replacement) this._observeEngineTurnMessage(replacement);

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(editedEntryId ?? targetId, label);
			}

			// Keep generated summary/label entries in the tree, not at the resumed conversation's tail.
			if (resume && (summaryText || label)) {
				this.sessionManager.branch(targetId);
			}

			// Update agent state (preserving exact messages still awaiting persistence)
			this._restoreAgentMessagesFromSession();
			this._delegatedCompactionKey = undefined;
			this._incrementMessageRevision();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Lifecycle handlers may append metadata too. Preserve it without changing an exact resume.
			if (resume && this.sessionManager.getLeafId() !== targetId) {
				this.sessionManager.branch(targetId);
				this._restoreAgentMessagesFromSession();
				this._incrementMessageRevision();
			}

			return { editorText, cancelled: false, summaryEntry, entryId: editedEntryId };
		} finally {
			// The navigation's two busy facts end together. Clearing the controller through its setter would recompute
			// while the barrier is still held and record a busy state after the navigation has already moved the leaf;
			// release both, then raise the one edge (senpi#4154 on top of #3980).
			this._branchSummaryAbortControllerValue = undefined;
			finishSessionWork();
			this.refreshLifecycle();
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

			const text = askUserAnswerDisplayText(entry.message.content) ?? contentText(entry.message.content, "");
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
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			const prewarmUsage = getPromptCachePrewarmUsage(entry);
			if (prewarmUsage) addUsageToTotals(usageTotals, prewarmUsage);
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
			...(usageTotals.costUnknown ? { costUnknown: true as const } : {}),
			contextUsage: this.getContextUsage(),
			failures: computeSessionFailureReport(this.sessionManager.getEntries()),
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

	/**
	 * Context usage is shown on every frame (footer), but it only changes when a message is appended or
	 * replaced, the branch moves, or the model changes. Messages are appended in place, so the key is the
	 * array, its length and last message (with a fingerprint of its content and usage, in case it grows
	 * in place), plus the leaf and the model's window.
	 */
	getContextUsage(): ContextUsage | undefined {
		const model = this._limitsModel();
		const runtimeMessages = this.messages;
		const key = {
			messages: runtimeMessages,
			length: runtimeMessages.length,
			last: runtimeMessages.at(-1),
			lastFingerprint: messageFingerprint(runtimeMessages.at(-1)),
			leafId: this.sessionManager.getLeafId(),
			contextWindow: model?.contextWindow,
		};
		const cached = this._contextUsageCache;
		if (
			cached !== undefined &&
			cached.key.messages === key.messages &&
			cached.key.length === key.length &&
			cached.key.last === key.last &&
			cached.key.lastFingerprint === key.lastFingerprint &&
			cached.key.leafId === key.leafId &&
			cached.key.contextWindow === key.contextWindow
		) {
			return cached.usage;
		}
		const usage = this._computeContextUsage(model);
		this._contextUsageCache = { key, usage };
		return usage;
	}

	private _contextUsageCache:
		| {
				readonly key: {
					readonly messages: AgentMessage[];
					readonly length: number;
					readonly last: AgentMessage | undefined;
					readonly lastFingerprint: string;
					readonly leafId: string | null;
					readonly contextWindow: number | undefined;
				};
				readonly usage: ContextUsage | undefined;
		  }
		| undefined;

	private _computeContextUsage(model: Model<any> | undefined): ContextUsage | undefined {
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
				return {
					tokens,
					contextWindow,
					percent: (tokens / contextWindow) * 100,
				};
			}
		}

		// A context_edit omits or replaces what earlier provider usage measured, so that usage no longer
		// describes the current context; estimate from the projection like the threshold check does.
		const estimate = branchEntries.some((entry) => entry.type === "context_edit")
			? estimateProjectedContextTokens(this.sessionManager.buildSessionProjection(), branchEntries)
			: estimateContextTokens(messages);
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
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		return await exportSessionToHtml(this.sessionManager, this.state, {
			...this.htmlExportOptions(options.themeName),
			outputPath,
		});
	}

	/** Render the session to HTML in memory, passing every value through `sanitize` (used by `/share`). */
	renderToHtml(options: { themeName?: string; sanitize: <T>(value: T) => T }): string {
		return renderSessionToHtml(this.sessionManager, this.state, {
			...this.htmlExportOptions(options.themeName),
			sanitize: options.sanitize,
		});
	}

	private htmlExportOptions(requestedTheme: string | undefined): ExportOptions {
		const themeName = [requestedTheme, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});
		return { themeName, toolRenderer };
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

		// The whole path from the file: a reopened or compacted session keeps only its latest window resident (senpi#3519).
		const branchEntries = this.sessionManager.getFullBranch();
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

/** Changes whenever a message's content grows or its usage is filled in, without walking other messages. */
function messageFingerprint(message: AgentMessage | undefined): string {
	if (message === undefined) return "";
	const content = (message as { content?: unknown }).content;
	let size = 0;
	if (typeof content === "string") size = content.length;
	else if (Array.isArray(content)) {
		for (const part of content as Array<{ text?: unknown; thinking?: unknown; arguments?: unknown }>) {
			size += 1;
			if (typeof part.text === "string") size += part.text.length;
			if (typeof part.thinking === "string") size += part.thinking.length;
		}
	}
	const usage = (message as { usage?: Usage }).usage;
	const requestContext = usage?.contextUsage;
	return `${size}:${usage?.input ?? ""}:${usage?.output ?? ""}:${usage?.totalTokens ?? ""}:${requestContext?.input}:${requestContext?.output}:${requestContext === null}`;
}
