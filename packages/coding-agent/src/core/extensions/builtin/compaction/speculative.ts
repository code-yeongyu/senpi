import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	hasCredentialHeaders,
	isContextOverflow,
	isRetryableAssistantError,
	isRetryableErrorMessage,
	type Message,
	type Model,
	retryTransientCall,
	type Tool,
} from "@earendil-works/pi-ai";
import {
	type CompactionPreparation,
	type CompactionResult,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	prepareCompaction,
} from "../../../compaction/index.ts";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../../compaction/stream-watchdog.ts";
import {
	createWarmAnchorSnapshot,
	isWarmSummaryAnchorValid,
	type WarmAnchorSnapshot,
} from "../../../compaction/warm-anchor.ts";
import { convertToLlm } from "../../../messages.ts";
import type { ModelRegistry } from "../../../model-registry.ts";
import type { ReadonlySessionManager } from "../../../session-manager.ts";
import type { ApplyCompactionResult, ContextUsage, ProviderRequestPreparation } from "../../types.ts";
import { pruneToolResults } from "./emergency-prune.ts";
import {
	allowOverflowRetry,
	boundSummarizationInput,
	SUMMARIZATION_INPUT_BUDGET_RATIO,
	SummarizationOverflowExhaustedError,
	shrinkSummarizationInputForOverflowRetry,
} from "./overflow-retry.ts";
import { computeEffectiveKeepRecentTokens, computeEffectiveThreshold } from "./policy.ts";
import { buildPrompt, type MergedCompactionPromptVariant } from "./prompts.ts";
import { generateSummaryMessage, getSummaryText, isAssistantMessage } from "./speculative-summary.ts";

import { allowSummarizationRetry, DEFAULT_SUMMARIZATION_RETRY_POLICY } from "./summarization-retry.ts";

import { extractTaskIntent, resolveInheritedTaskIntent } from "./task-intent.ts";

export {
	createEmergencyPruneLatch,
	type EmergencyPruneLatch,
	hardLimitEmergencyPrune,
	truncateContextMessages,
} from "./emergency-prune.ts";

import { computeStructuralYield } from "./yield.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;
// Hysteresis: the emergency prune engages at EMERGENCY_CONTEXT_TARGET_RATIO but only
// releases once the context falls below this lower ratio. A single threshold makes a
// session parked near the limit alternate between the pruned and un-pruned history on
// consecutive requests; because pruning rewrites old tool results, every alternation
// invalidates the provider prompt-cache prefix and re-bills the whole conversation.
const SUMMARY_SCHEMA = "senpi.compaction.summary.v1";
type CompactionProgressCallback = (delta: string) => void;

export interface SpeculativeCompactionContext {
	model: Model<any> | undefined;
	sessionManager: ReadonlySessionManager;
	modelRegistry?: ModelRegistry;
	getContextUsage(): ContextUsage | undefined;
	getCompactionSettings?(): CompactionPreparation["settings"];
	getMessageRevision(): number;
	getSystemPrompt?(): string;
	prepareProviderRequest?(messages: AgentMessage[]): Promise<ProviderRequestPreparation>;
	isIdle?(): boolean;
	applyCompaction(
		precomputed: CompactionResult,
		options: {
			reason: "extension";
			expectedRevision?: number;
			expectedWarmAnchor?: WarmAnchorSnapshot;
			signal?: AbortSignal;
		},
	): Promise<ApplyCompactionResult>;
}

export interface SpeculativeCompactionSnapshot {
	generation: number;
	expectedRevision: number;
	model: Model<any>;
	contextWindow: number;
	preparation: CompactionPreparation;
	branchEntries?: ReturnType<ReadonlySessionManager["getBranch"]>;
	promptVariant: MergedCompactionPromptVariant;
	origin?: "speculative" | "blocking" | "core-route";
	customInstructions?: string;
	/** Agent system prompt; used to make the summarization request look like normal agent traffic. */
	systemPrompt?: string;
	/** Agent tool definitions; forwarded so the request shape matches normal agent traffic. */
	tools?: Tool[];
}

export type SpeculativeCompactionResult = ApplyCompactionResult | { applied: false; reason: "unavailable" | "failed" };

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Summary-generation failure with a user-facing diagnosis. Distinct from a
 * user abort (which resolves `undefined`): callers surface `message` on the
 * manual route and degrade to "unavailable" on automatic routes.
 */
/**
 * Provider `error` stop during summarization, carrying the metadata-aware
 * transient classification from the full assistant message. A refusal whose
 * text happens to look retryable must still surface loudly; the message
 * string alone cannot encode that.
 */
export type SummaryRequestFailureKind = "upstream-stream-truncated";

export class SummaryRequestError extends Error {
	readonly transient: boolean;
	readonly failureKind?: SummaryRequestFailureKind;

	constructor(message: string, transient: boolean, failureKind?: SummaryRequestFailureKind) {
		super(message);
		this.name = "SummaryRequestError";
		this.transient = transient;
		this.failureKind = failureKind;
	}
}

const UPSTREAM_STREAM_TRUNCATED_PATTERN = /(?:^|[^A-Za-z0-9_])upstream_stream_truncated(?:[^A-Za-z0-9_]|$)/;

/**
 * Only failures with no cheaper recovery earn another billed request.
 *
 * Every class that `classifyRequiredCompactionFallbackFailure` recognizes
 * (watchdog timeouts, `upstream-stream-truncated`, overflow exhaustion) already
 * has a deterministic zero-LLM recovery, and context overflow is answered by
 * shrinking the input in the surrounding loop - replaying those would pay for a
 * summarization the fallback can rebuild for free. The classes checked here are
 * mirrored from that classifier rather than imported, because
 * `deterministic-fallback.ts` imports this module.
 */
function isRetryableSummaryAttempt(error: unknown): boolean {
	if (error instanceof StreamDurationBudgetError || error instanceof StreamIdleTimeoutError) return false;
	if (error instanceof SummarizationOverflowExhaustedError) return false;
	if (error instanceof SummaryGenerationError) return false;
	if (error instanceof SummaryRequestError) return error.failureKind === undefined && error.transient;
	if (error instanceof Error) return isRetryableErrorMessage(error.message);
	return false;
}

function summaryRequestFailureKind(response: AssistantMessage): SummaryRequestFailureKind | undefined {
	if (response.stopDetails?.type === "refusal" || response.stopDetails?.type === "sensitive") return undefined;
	return UPSTREAM_STREAM_TRUNCATED_PATTERN.test(response.errorMessage ?? "") ? "upstream-stream-truncated" : undefined;
}

export class SummaryGenerationError extends Error {
	readonly kind: "auth" | "empty-summary";

	constructor(kind: "auth" | "empty-summary", message: string) {
		super(message);
		this.name = "SummaryGenerationError";
		this.kind = kind;
	}
}

/**
 * Output budget for one summarization request. Adaptive-thinking models emit
 * reasoning tokens before the summary text, so the legacy flat 8192 cap could
 * be consumed entirely by thinking, ending the stream with zero text blocks.
 * Grant generous headroom, clamped to what the model can actually emit and to
 * half the context window: providers that enforce input + output <= window
 * would otherwise reject the request for models advertising contextWindow ==
 * maxTokens (every summarization request also carries conversation input).
 */

export function getPromptVariant(options: {
	reason: string;
	preparation: { previousSummary?: string; isSplitTurn: boolean };
}): MergedCompactionPromptVariant {
	if (options.reason === "branch") return "branch";
	if (options.preparation.previousSummary) return "update";
	if (options.preparation.isSplitTurn) return "turn_prefix";
	return "default";
}

export function createSpeculativeCompactionSnapshot(
	context: SpeculativeCompactionContext,
	options: {
		customInstructions?: string;
		generation: number;
		origin?: "speculative" | "blocking" | "core-route";
		tools?: Tool[];
	},
): SpeculativeCompactionSnapshot | undefined {
	const model = context.model;
	if (!model) return undefined;

	const expectedRevision = context.getMessageRevision();
	const branchEntries = context.sessionManager.getBranch();
	const contextWindow = context.getContextUsage()?.contextWindow ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const settings = context.getCompactionSettings?.() ?? DEFAULT_COMPACTION_SETTINGS;
	const thresholdRatio = computeEffectiveThreshold(contextWindow);
	const preparation = prepareCompaction(branchEntries, {
		...settings,
		keepRecentTokens: computeEffectiveKeepRecentTokens(settings.keepRecentTokens, contextWindow, thresholdRatio),
	});
	if (!preparation) return undefined;

	return {
		...options,
		expectedRevision,
		model,
		contextWindow,
		preparation,
		branchEntries,
		promptVariant: getPromptVariant({ reason: "extension", preparation }),
		systemPrompt: context.getSystemPrompt?.(),
	};
}

/**
 * Generate a compaction summary for the snapshot. Resolves `undefined` only
 * when the request was aborted (caller signal or an aborted stream); every
 * other failure throws — {@link SummaryGenerationError} for diagnosable
 * generation failures, the raw provider error otherwise. Abort is checked
 * before and after credential resolution so a cancelled request never
 * misreports as an auth failure.
 */
export async function runExtensionCompaction(
	context: SpeculativeCompactionContext,
	snapshot: SpeculativeCompactionSnapshot,
	signal?: AbortSignal,
	onProgress?: CompactionProgressCallback,
): Promise<CompactionResult | undefined> {
	if (signal?.aborted) return undefined;
	const auth = await context.modelRegistry?.getApiKeyAndHeaders(snapshot.model);
	if (signal?.aborted) return undefined;
	// A provider is authenticated for summarization by either a resolved key or a
	// credential request header: `headers`-authenticated providers (models.json and
	// extension providers alike) never resolve an apiKey, yet their normal agent
	// turns are fully authenticated.
	if (!auth?.ok || !(auth.apiKey || hasCredentialHeaders(auth.headers))) {
		const detail =
			auth && !auth.ok ? auth.error : `no credentials resolved for provider "${snapshot.model.provider}"`;
		throw new SummaryGenerationError("auth", `summarization credentials unavailable: ${detail}`);
	}
	const requestSnapshot = auth.baseUrl
		? { ...snapshot, model: { ...snapshot.model, baseUrl: auth.baseUrl } }
		: snapshot;

	const prompt = buildPrompt({
		variant: requestSnapshot.promptVariant,
		previousSummary: requestSnapshot.preparation.previousSummary,
		taskIntent: resolveInheritedTaskIntent(requestSnapshot.branchEntries ?? []),
		customInstructions: requestSnapshot.customInstructions,
	});
	const promptTokens = approxTokens(prompt.user);
	let messages = boundSummarizationInput(
		pruneToolResults(
			[...requestSnapshot.preparation.messagesToSummarize, ...requestSnapshot.preparation.turnPrefixMessages],
			requestSnapshot.contextWindow,
			SUMMARIZATION_INPUT_BUDGET_RATIO,
		),
		requestSnapshot.contextWindow,
		promptTokens,
	);
	const overflowRetryStartMs = Date.now();
	let overflowAttempts = 0;

	while (true) {
		if (signal?.aborted) return undefined;
		let response: Message | undefined;
		const currentMessages = messages;
		const retryStartedMs = Date.now();
		// Only the routes that block the user's turn retry here. The speculative
		// warm-up owns its own bounded retry (`idle-retry.ts`) with idle/breaker
		// guards re-evaluated between attempts, and a failed warm job must stay
		// inheritable so the next blocking route degrades on it instead of paying
		// for a second request.
		const retryEligible = snapshot.origin === "core-route" || snapshot.origin === "blocking";
		try {
			// The provider `error` stop is raised INSIDE the retried producer so a
			// transient summarization failure spends the shared retry budget. The
			// surrounding loop keeps overflow shrinking and abort handling, which
			// must never be answered by replaying the same request.
			response = await retryTransientCall(
				async () => {
					const attempt = await generateSummaryMessage({
						context,
						messages: currentMessages,
						onProgress,
						prompt,
						signal,
						snapshot: requestSnapshot,
						auth: {
							apiKey: auth.apiKey,
							headers: auth.headers,
							extraBody: auth.extraBody,
						},
					});
					if (
						attempt &&
						isAssistantMessage(attempt) &&
						attempt.stopReason === "error" &&
						!isContextOverflow(attempt, snapshot.contextWindow)
					) {
						const failureKind = summaryRequestFailureKind(attempt);
						throw new SummaryRequestError(
							attempt.errorMessage || "Compaction summary request failed",
							failureKind !== undefined || isRetryableAssistantError(attempt),
							failureKind,
						);
					}
					return attempt;
				},
				(error) =>
					retryEligible &&
					allowSummarizationRetry(Date.now() - retryStartedMs) &&
					isRetryableSummaryAttempt(error),
				DEFAULT_SUMMARIZATION_RETRY_POLICY,
				signal,
			);
		} catch (error) {
			if (signal?.aborted) return undefined;
			throw error;
		}
		if (!response) return undefined;

		if (isAssistantMessage(response) && isContextOverflow(response, snapshot.contextWindow)) {
			overflowAttempts++;
			const elapsedMs = Date.now() - overflowRetryStartMs;
			const retryMessages = allowOverflowRetry(overflowAttempts, elapsedMs)
				? shrinkSummarizationInputForOverflowRetry(messages, snapshot.contextWindow, promptTokens)
				: undefined;
			if (!retryMessages) {
				throw new SummarizationOverflowExhaustedError(overflowAttempts, elapsedMs);
			}
			messages = retryMessages;
			continue;
		}

		if (isAssistantMessage(response) && response.stopReason === "aborted") {
			// A partial summary from an aborted stream must never be applied.
			return undefined;
		}

		if (isAssistantMessage(response) && response.stopReason === "error") {
			// Surface the real provider failure instead of silently degrading
			// into a generic "Compaction cancelled". Preserve the structured
			// truncation class here so downstream recovery never trusts arbitrary
			// thrown error text as authorization for destructive context reduction.
			const failureKind = summaryRequestFailureKind(response);
			throw new SummaryRequestError(
				response.errorMessage || "Compaction summary request failed",
				failureKind !== undefined || isRetryableAssistantError(response),
				failureKind,
			);
		}

		const summary = getSummaryText(response);
		if (!summary) {
			const stopReason = isAssistantMessage(response) ? response.stopReason : "unknown";
			throw new SummaryGenerationError(
				"empty-summary",
				`summarization response contained no text (stopReason: ${stopReason})`,
			);
		}

		// Informational only: the core rejects an applied compaction that would
		// still overflow (_wouldCompactionOverflow). Rejecting here based on the
		// size of the *discarded* input made large sessions uncompactable.
		const tokenEstimate = estimateContextTokens(convertToLlm(messages)).tokens + approxTokens(summary);
		const parsedSummary = extractTaskIntent(summary);
		const taskIntent = parsedSummary.taskIntent ?? resolveInheritedTaskIntent(snapshot.branchEntries ?? []);

		return {
			summary: parsedSummary.summaryText,
			firstKeptEntryId: snapshot.preparation.firstKeptEntryId,
			tokensBefore: snapshot.preparation.tokensBefore,
			details: {
				schema: SUMMARY_SCHEMA,
				promptVariant: snapshot.promptVariant,
				tokenEstimate,
				structuralYield: computeStructuralYield({
					previousSummary: snapshot.preparation.previousSummary ?? "",
					messagesToSummarize: snapshot.preparation.messagesToSummarize,
					turnPrefixMessages: snapshot.preparation.turnPrefixMessages,
					summary: parsedSummary.summaryText,
					tokensBefore: snapshot.preparation.tokensBefore,
				}),
				...(snapshot.origin ? { origin: snapshot.origin } : {}),
				...(taskIntent ? { taskIntent } : {}),
			},
		};
	}
}

export async function applyGeneratedCompaction(
	context: SpeculativeCompactionContext,
	snapshot: SpeculativeCompactionSnapshot | undefined,
	getCurrentGeneration: () => number,
	compaction: CompactionResult | undefined,
	signal?: AbortSignal,
): Promise<SpeculativeCompactionResult> {
	const provider = context.model?.provider;
	if ((provider === "cursor" || provider === "cursor-cli-oauth") && context.isIdle && !context.isIdle()) {
		return { applied: false, reason: "rejected" };
	}
	if (!snapshot || !compaction) return { applied: false, reason: "unavailable" };

	if (snapshot.generation !== getCurrentGeneration()) {
		return { applied: false, reason: "stale" };
	}

	const revisionUnchanged = snapshot.expectedRevision === context.getMessageRevision();
	const warmAnchor = createWarmAnchorSnapshot(snapshot.preparation.firstKeptEntryId, snapshot.branchEntries ?? []);
	if (
		!revisionUnchanged &&
		(!warmAnchor || !isWarmSummaryAnchorValid(warmAnchor, context.sessionManager.getBranch()))
	) {
		return { applied: false, reason: "stale" };
	}

	return await context.applyCompaction(compaction, {
		reason: "extension",
		...(revisionUnchanged || !warmAnchor
			? { expectedRevision: snapshot.expectedRevision }
			: { expectedWarmAnchor: warmAnchor }),
		signal,
	});
}

export async function applySpeculativeCompaction(
	context: SpeculativeCompactionContext,
	snapshot: SpeculativeCompactionSnapshot | undefined,
	getCurrentGeneration: () => number,
	generate: () => Promise<CompactionResult | undefined>,
): Promise<SpeculativeCompactionResult> {
	if (!snapshot) return { applied: false, reason: "unavailable" };

	const compaction = await generate();
	return await applyGeneratedCompaction(context, snapshot, getCurrentGeneration, compaction);
}
