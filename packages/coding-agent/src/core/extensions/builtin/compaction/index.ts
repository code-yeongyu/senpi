import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../../compaction/index.ts";
import { convertToLlm } from "../../../messages.ts";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "../../types.ts";
import * as checkpointState from "./checkpoint-state.ts";
import * as breaker from "./circuit-breaker.ts";
import {
	BUILTIN_CONTEXT_REDUCTION_OPTIONS,
	reduceContextMessages,
	shouldApplyContextReduction,
} from "./context-reduction.ts";
import {
	createDegradationMonitorState,
	handleMessageEnd,
	handleTurnEnd,
	RECOVERY_INSTRUCTIONS,
	resetOnSessionCompact,
} from "./degradation-monitor.ts";
import {
	classifyRequiredCompactionFallbackFailure,
	createRequiredCompactionFallback,
} from "./deterministic-fallback.ts";
import * as idle from "./idle.ts";
import {
	CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE,
	collectCompactBoundaryEntries,
	createCompactionLanePolicy,
	SDK_NATIVE_LANE_REJECTION_REASON,
} from "./lane-policy.ts";
import { type CompactionLogger, createCompactionLogger } from "./log.ts";
import {
	markOpenAiRemoteReplayBoundary,
	type OpenAiRemoteCompactionDependencies,
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
	SENPI_COMPACTION_EVENT,
} from "./openai-remote.ts";
import {
	createOpenAiRemoteCompactionHeaders,
	isOpenAiRemoteCompactionModel,
	openAiRemoteCompactionOrigin,
} from "./openai-remote-model.ts";
import * as cap from "./per-turn-cap.ts";
import * as policy from "./policy.ts";
import { repairOrphanedToolResults } from "./repair-tool-pairs.ts";
import * as restoration from "./restoration-tracker.ts";
import {
	applyGeneratedCompaction,
	createEmergencyPruneLatch,
	createSpeculativeCompactionSnapshot,
	getPromptVariant,
	hardLimitEmergencyPrune,
	runExtensionCompaction,
	type SpeculativeCompactionResult,
	type SpeculativeCompactionSnapshot,
	SummaryGenerationError,
} from "./speculative.ts";
import { type CompactionExtensionState, createInitialState, resetTurnCounter } from "./state.ts";
import { resolveInheritedTaskIntent } from "./task-intent.ts";
import * as todoBridge from "./todo-bridge.ts";
import { isTransientSummarizationFailure } from "./transient-failure.ts";
import { isIneffectiveCompaction } from "./yield.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const EMERGENCY_COMPACTION_INSTRUCTIONS =
	"EMERGENCY: hard context limit reached. Produce an aggressive recovery summary that preserves current goal, constraints, files touched, tool outcomes, and exact next steps. Prefer concise factual state over transcript detail.";
const PROACTIVE_COMPACTION_INSTRUCTIONS = "Proactively compact before the next agent turn.";
const MAX_PENDING_METADATA = 8;
const IMAGE_PROMPT_TOKEN_ESTIMATE = 1_200;
const MAX_OUTPUT_RESERVE_RATIO = 0.5;

interface PendingCompactionMetadata {
	checkpoint: checkpointState.AgentCheckpoint;
	todoSnapshot: todoBridge.TodoSnapshotPayload;
}

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimatePendingPromptTokens(event: { prompt?: string; images?: readonly unknown[] }): number {
	return approxTokens(event.prompt ?? "") + (event.images?.length ?? 0) * IMAGE_PROMPT_TOKEN_ESTIMATE;
}

function getPromptContextWindow(contextWindow: number, maxTokens: number | undefined): number {
	if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0 || contextWindow <= 0) {
		return contextWindow;
	}
	const outputReserve = Math.min(maxTokens, Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO));
	return contextWindow - outputReserve;
}

function withAdditionalTokens(usage: ContextUsage, additionalTokens: number): ContextUsage {
	if (usage.tokens === null || additionalTokens <= 0) return usage;
	const tokens = usage.tokens + additionalTokens;
	return {
		...usage,
		tokens,
		percent: usage.contextWindow > 0 ? (tokens / usage.contextWindow) * 100 : usage.percent,
	};
}

function isMonitorableMessageEvent(event: { message: AgentMessage }): event is {
	message: AgentMessage & { content: Array<{ type: string; text?: string }> };
} {
	return "content" in event.message && Array.isArray(event.message.content);
}

function isAbortedAssistantMessage(event: { message: AgentMessage }): boolean {
	return event.message.role === "assistant" && "stopReason" in event.message && event.message.stopReason === "aborted";
}

function isRequiredCompactionFallbackReason(reason: SessionBeforeCompactEvent["reason"]): boolean {
	return reason === "threshold" || reason === "overflow";
}

function recentCheckpoint(ctx: ExtensionContext): checkpointState.AgentCheckpoint | null {
	const checkpoint = checkpointState.getLatestCheckpoint(ctx);
	if (!checkpoint?.timestamp) return null;
	return Date.now() - checkpoint.timestamp <= 60_000 ? checkpoint : null;
}

function shouldEndFeedback(result: SpeculativeCompactionResult): boolean {
	return !result.applied && result.reason !== "rejected";
}

function endCompactionFeedback(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	result: SpeculativeCompactionResult,
): void {
	if (shouldEndFeedback(result)) {
		ctx.endCompaction?.({ reason: "extension", signal, aborted: signal?.aborted });
	}
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	if (source.aborted) {
		target.abort();
		return () => {};
	}
	const abort = () => target.abort();
	source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

function createBlockingRemoteCompactionEvent(
	ctx: ExtensionContext,
	snapshot: SpeculativeCompactionSnapshot,
	customInstructions: string,
	signal: AbortSignal,
): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "extension",
		willRetry: false,
		requestId: randomUUID(),
		preparation: snapshot.preparation,
		branchEntries: ctx.sessionManager.getBranch(),
		customInstructions,
		signal,
	};
}

export default function compactionExtension(
	pi: ExtensionAPI,
	remoteCompactionDependencies: OpenAiRemoteCompactionDependencies = {},
): void {
	let state: CompactionExtensionState = createInitialState();
	const lanePolicy = createCompactionLanePolicy();
	const restorationDirectiveState = checkpointState.createRestorationDirectiveState();
	const emergencyPruneLatch = createEmergencyPruneLatch();
	const degradationState = createDegradationMonitorState();
	const restorationState = state.restoration ?? restoration.createRestorationTrackerState();
	state = { ...state, restoration: restorationState };
	let speculativeGeneration = 0;
	let speculativeJob:
		| {
				generation: number;
				snapshot: SpeculativeCompactionSnapshot;
				controller: AbortController;
				promise: Promise<CompactionResult | undefined>;
				failure: Promise<Error | undefined>;
		  }
		| undefined;
	const pendingMetadata = new Map<string, PendingCompactionMetadata>();
	let logger: CompactionLogger | undefined;
	interface CompactionContext extends ExtensionContext {
		agentDir?: string;
	}
	const getLogger = (ctx: CompactionContext): CompactionLogger => (logger ??= createCompactionLogger(ctx.agentDir));

	function getSummarizationTools(): Tool[] {
		if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") return [];
		try {
			const definitionsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			return pi.getActiveTools().flatMap((name) => {
				const tool = definitionsByName.get(name);
				return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
			});
		} catch {
			return [];
		}
	}

	function invalidateSpeculativeCompaction(ctx: ExtensionContext): void {
		const previousGeneration = speculativeGeneration;
		speculativeGeneration++;
		getLogger(ctx).debug("speculative_invalidated", { generation: previousGeneration });
		speculativeJob?.controller.abort();
		speculativeJob = undefined;
	}

	function startSpeculativeCompaction(ctx: ExtensionContext, customInstructions: string): void {
		if (speculativeJob) return;
		const generation = ++speculativeGeneration;
		const snapshot = createSpeculativeCompactionSnapshot(ctx, {
			generation,
			customInstructions,
			origin: "speculative",
			tools: getSummarizationTools(),
		});
		if (!snapshot) return;
		getLogger(ctx).debug("speculative_started", { generation, origin: "speculative" });
		const controller = new AbortController();
		const settled = runExtensionCompaction(ctx, snapshot, controller.signal).then(
			(result) => ({ result, error: undefined }),
			(error: unknown) => ({ result: undefined, error: error instanceof Error ? error : new Error(String(error)) }),
		);
		const promise = settled.then(({ result }) => result);
		const failure = settled.then(({ error }) => error);
		speculativeJob = { generation, snapshot, controller, promise, failure };
	}

	function capturePendingMetadata(requestId: string, ctx: ExtensionContext): void {
		pendingMetadata.set(requestId, {
			checkpoint: checkpointState.captureAgentCheckpoint(pi, ctx),
			todoSnapshot: todoBridge.createTodoSnapshot(ctx),
		});
		while (pendingMetadata.size > MAX_PENDING_METADATA) {
			const oldestRequestId = pendingMetadata.keys().next().value;
			if (oldestRequestId === undefined) break;
			pendingMetadata.delete(oldestRequestId);
		}
	}

	function persistAcceptedMetadata(requestId: string): void {
		const metadata = pendingMetadata.get(requestId);
		if (!metadata) return;
		pendingMetadata.delete(requestId);
		checkpointState.persistCheckpoint(pi, metadata.checkpoint);
		todoBridge.persistTodoSnapshot(pi, metadata.todoSnapshot);
	}

	async function applyBlockingCompaction(
		ctx: ExtensionContext,
		customInstructions: string,
	): Promise<SpeculativeCompactionResult> {
		if (breaker.isTripped(state, Date.now())) {
			getLogger(ctx).debug("skip_breaker", { route: "blocking" });
			return { applied: false, reason: "rejected" };
		}
		if (cap.shouldRejectByCap(state).cancel) {
			getLogger(ctx).debug("skip_cap", { route: "blocking" });
			return { applied: false, reason: "rejected" };
		}
		let feedbackSignal = ctx.beginCompaction?.({ reason: "extension" });
		try {
			if (isOpenAiRemoteCompactionModel(ctx.model)) {
				const remoteGeneration = speculativeGeneration + 1;
				const remoteSnapshot = createSpeculativeCompactionSnapshot(ctx, {
					generation: remoteGeneration,
					customInstructions,
					origin: "blocking",
				});
				getLogger(ctx).debug("blocking_started", { generation: remoteGeneration, origin: "blocking" });
				if (remoteSnapshot) {
					const remoteSignal = feedbackSignal ?? new AbortController().signal;
					const remoteCompaction = await runOpenAiRemoteCompaction(
						ctx,
						createBlockingRemoteCompactionEvent(ctx, remoteSnapshot, customInstructions, remoteSignal),
						(data) => pi.events.emit(SENPI_COMPACTION_EVENT, data),
						remoteCompactionDependencies,
					);
					if (remoteCompaction) {
						if (speculativeGeneration !== remoteGeneration - 1) {
							const result = { applied: false, reason: "stale" } as const;
							getLogger(ctx).debug("speculative_stale", { generation: remoteGeneration });
							endCompactionFeedback(ctx, feedbackSignal, result);
							return result;
						}
						speculativeGeneration = remoteGeneration;
						speculativeJob?.controller.abort();
						speculativeJob = undefined;
						const result = await applyGeneratedCompaction(
							ctx,
							remoteSnapshot,
							() => speculativeGeneration,
							remoteCompaction,
							feedbackSignal,
						);
						getLogger(ctx).debug("speculative_applied", { generation: remoteGeneration, origin: "blocking" });
						endCompactionFeedback(ctx, feedbackSignal, result);
						return result;
					}
				}
			}

			const pendingJob = speculativeJob;
			if (pendingJob) {
				const unlinkAbort = linkAbortSignal(feedbackSignal, pendingJob.controller);
				let compaction: CompactionResult | undefined;
				let inheritedFailure: Error | undefined;
				try {
					compaction = await pendingJob.promise;
					inheritedFailure = await pendingJob.failure;
					if (compaction)
						getLogger(ctx).debug("warm_consumed", { generation: pendingJob.generation, route: "speculative" });
				} finally {
					unlinkAbort();
				}
				if (inheritedFailure !== undefined) {
					speculativeJob = undefined;
					if (isTransientSummarizationFailure(inheritedFailure, inheritedFailure.message)) {
						ctx.endCompaction?.({
							reason: "extension",
							signal: feedbackSignal,
							aborted: feedbackSignal?.aborted,
							errorMessage: `Compaction failed: ${inheritedFailure.message}`,
						});
						state = breaker.recordFailure(state, Date.now(), { route: "extension" });
						return { applied: false, reason: "failed" };
					}
				}
				const result = await applyGeneratedCompaction(
					ctx,
					pendingJob.snapshot,
					() => speculativeGeneration,
					compaction,
					feedbackSignal,
				);
				if (result.applied || result.reason === "stale") {
					speculativeJob = undefined;
					if (result.applied)
						getLogger(ctx).debug("speculative_applied", {
							generation: pendingJob.generation,
							origin: "speculative",
						});
					else getLogger(ctx).debug("speculative_stale", { generation: pendingJob.generation });
					endCompactionFeedback(ctx, feedbackSignal, result);
					return result;
				}
				if (result.reason === "rejected") {
					feedbackSignal = ctx.beginCompaction?.({ reason: "extension" });
				}
				speculativeJob = undefined;
			}

			const generation = ++speculativeGeneration;
			const snapshot = createSpeculativeCompactionSnapshot(ctx, {
				generation,
				customInstructions,
				origin: "core-route",
				tools: getSummarizationTools(),
			});
			if (!snapshot) {
				const result = { applied: false, reason: "unavailable" } as const;
				getLogger(ctx).debug("summary_failed", { reason: "unavailable" });
				endCompactionFeedback(ctx, feedbackSignal, result);
				return result;
			}
			let compaction: CompactionResult | undefined;
			try {
				compaction = await runExtensionCompaction(ctx, snapshot, feedbackSignal, (delta) =>
					ctx.updateCompaction?.({
						reason: "extension",
						signal: feedbackSignal,
						delta,
					}),
				);
			} catch (error) {
				if (!(error instanceof SummaryGenerationError)) throw error;
				getLogger(ctx).debug("summary_failed", { reason: error.kind });
			}
			const result = await applyGeneratedCompaction(
				ctx,
				snapshot,
				() => speculativeGeneration,
				compaction,
				feedbackSignal,
			);
			endCompactionFeedback(ctx, feedbackSignal, result);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.endCompaction?.({
				reason: "extension",
				signal: feedbackSignal,
				aborted: feedbackSignal?.aborted,
				errorMessage: `Compaction failed: ${message}`,
			});
			const transient = isTransientSummarizationFailure(error, message);
			if (transient) {
				state = breaker.recordFailure(state, Date.now(), { route: "extension" });
				return { applied: false, reason: "failed" };
			}
			throw error;
		}
	}

	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
		invalidateSpeculativeCompaction(ctx);
		if (lanePolicy.disablesSenpiCompaction(ctx)) {
			return { cancel: true, reason: SDK_NATIVE_LANE_REJECTION_REASON };
		}
		if (cap.shouldRejectByCap(state, { reason: event.reason }).cancel) {
			getLogger(ctx).debug("skip_cap", { reason: event.reason, count: state.acceptedThisTurn });
			return {
				cancel: true,
				rejectionCause: "per-turn-cap",
				reason: "per-turn compaction cap reached for this turn",
			};
		}
		const now = Date.now();
		if (breaker.isTripped(state, now) && !breaker.shouldBypass(state, { reason: event.reason })) {
			const remainingMs = state.trippedAt !== null ? Math.max(0, state.trippedAt + breaker.COOLDOWN_MS - now) : 0;
			getLogger(ctx).debug("skip_breaker", { reason: event.reason, remainingSec: Math.ceil(remainingMs / 1000) });
			return {
				cancel: true,
				rejectionCause: "circuit-breaker",
				reason: `compaction circuit breaker cooling down (${Math.ceil(remainingMs / 1000)}s left)`,
			};
		}

		capturePendingMetadata(event.requestId, ctx);

		const model = ctx.model;
		if (!model) return undefined;
		const remoteCompaction = await runOpenAiRemoteCompaction(
			ctx,
			event,
			(data) => pi.events.emit(SENPI_COMPACTION_EVENT, data),
			remoteCompactionDependencies,
		);
		if (remoteCompaction) {
			getLogger(ctx).debug("core_route_generated", { route: "core-route", requestId: event.requestId });
			return { compaction: remoteCompaction };
		}

		const snapshot = {
			generation: ++speculativeGeneration,
			expectedRevision: ctx.getMessageRevision(),
			model,
			contextWindow: ctx.getContextUsage()?.contextWindow ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			preparation: event.preparation,
			branchEntries: event.branchEntries,
			promptVariant: getPromptVariant(event),
			origin: "core-route" as const,
			customInstructions: event.customInstructions,
			systemPrompt: ctx.getSystemPrompt(),
			tools: getSummarizationTools(),
		};
		let compaction: CompactionResult | undefined;
		try {
			compaction = await runExtensionCompaction(ctx, snapshot, event.signal, (delta) =>
				ctx.updateCompaction?.({ reason: event.reason, signal: event.signal, delta }),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failureKind = classifyRequiredCompactionFallbackFailure(error);
			if (isRequiredCompactionFallbackReason(event.reason) && failureKind !== undefined && !event.signal.aborted) {
				const fallback = createRequiredCompactionFallback(
					snapshot.preparation,
					snapshot.contextWindow,
					failureKind,
					{ taskIntent: resolveInheritedTaskIntent(event.branchEntries) },
					event.branchEntries,
				);
				if (fallback) return { compaction: fallback };
				pendingMetadata.delete(event.requestId);
				return {
					cancel: true,
					reason: "deterministic compaction fallback cannot retain the prepared suffix",
				};
			}
			pendingMetadata.delete(event.requestId);
			if (error instanceof SummaryGenerationError) {
				return { cancel: true, reason: error.message };
			}
			return { cancel: true, reason: `compaction generator failed: ${message}` };
		}
		if (!compaction) {
			pendingMetadata.delete(event.requestId);
			if (event.signal.aborted) {
				return { cancel: true };
			}
			return { cancel: true, reason: "compaction generator returned no summary" };
		}

		return {
			compaction,
		};
	});

	pi.on("model_select", (event, ctx) => {
		if (lanePolicy.disablesSenpiCompaction(ctx)) {
			invalidateSpeculativeCompaction(ctx);
			return;
		}
		const jobModel = speculativeJob?.snapshot.model;
		const selectedModel = ctx.model;
		const alreadySpeculatingForSelectedModel =
			jobModel !== undefined &&
			selectedModel !== undefined &&
			jobModel.api === selectedModel.api &&
			jobModel.provider === selectedModel.provider &&
			jobModel.id === selectedModel.id &&
			jobModel.baseUrl === selectedModel.baseUrl &&
			jobModel.contextWindow === selectedModel.contextWindow;
		if (!alreadySpeculatingForSelectedModel) {
			invalidateSpeculativeCompaction(ctx);
		}
		const previousWindow = event.previousModel?.contextWindow ?? 0;
		const contextWindow = ctx.model?.contextWindow ?? 0;
		if (previousWindow <= contextWindow) return;
		const usage = ctx.getContextUsage();
		if (!usage) return;
		if (breaker.isTripped(state, Date.now())) return;
		const settings = ctx.getCompactionSettings();
		if (policy.shouldStartSpeculativeCompaction(usage, contextWindow, settings, state.lastYield ?? undefined)) {
			startSpeculativeCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS);
		}
	});

	pi.on("session_compact", async (event: SessionCompactEvent, ctx) => {
		const compactEvent = event;
		invalidateSpeculativeCompaction(ctx);
		if (compactEvent.accepted) {
			persistAcceptedMetadata(compactEvent.requestId);
			const branchEntries = ctx.sessionManager.getBranch();
			const firstKeptIndex = branchEntries.findIndex(
				(entry) => entry.id === compactEvent.compactionEntry.firstKeptEntryId,
			);
			const keptEntries = firstKeptIndex === -1 ? [] : branchEntries.slice(firstKeptIndex);
			state = cap.incrementAccepted(state);
			state = breaker.recordSuccess(state);
			const details = compactEvent.compactionEntry.details as
				| { structuralYield?: { savedTokens: number; savingsRatio: number } }
				| undefined;
			const sy = details?.structuralYield;
			if (sy && typeof sy.savedTokens === "number" && typeof sy.savingsRatio === "number") {
				state = {
					...state,
					lastYield: { savedTokens: sy.savedTokens, tokensBefore: compactEvent.compactionEntry.tokensBefore },
				};
				if (
					isIneffectiveCompaction({
						tokensBefore: compactEvent.compactionEntry.tokensBefore,
						savedTokens: sy.savedTokens,
						savingsRatio: sy.savingsRatio,
					})
				) {
					state = cap.incrementIneffective(state);
					getLogger(ctx).debug("ineffective_counted", {
						tokensBefore: compactEvent.compactionEntry.tokensBefore,
						savedTokens: sy.savedTokens,
						savingsRatio: sy.savingsRatio,
					});
				}
			}
			resetOnSessionCompact(degradationState);
			todoBridge.restoreTodosIfMissing(pi, ctx);
			const usage = ctx.getContextUsage();
			const settings = ctx.getCompactionSettings();
			if (settings.restorationEnabled ?? true) {
				restoration.preparePendingPayload(restorationState, {
					accepted: true,
					reason: compactEvent.reason,
					compactionEntryId: compactEvent.compactionEntry.id,
					contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
					usageTokens: usage?.tokens ?? null,
					reserveTokens: settings.reserveTokens,
					settings,
					keptMessages: keptEntries.flatMap((entry) => {
						if (entry.type !== "message") return [];
						return [entry.message];
					}),
				});
			}
			return;
		}
		state = breaker.recordFailure(state, Date.now(), { route: compactEvent.reason });
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const message = checkpointState.attachRestorationDirective(
			restorationDirectiveState,
			recentCheckpoint(ctx),
			restoration.consumePendingPayload(restorationState),
		);

		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const settings = ctx.getCompactionSettings();
		const pendingPromptTokens = estimatePendingPromptTokens(event);
		const usageWithPendingPrompt = usage ? withAdditionalTokens(usage, pendingPromptTokens) : undefined;
		// The SDK owns this lane's context entirely, so even the hard-limit valve stands down;
		// the circuit breaker never blocks that valve for senpi-owned lanes.
		const laneOwnsCompaction = lanePolicy.disablesSenpiCompaction(ctx);
		const breakerCoolingDown = breaker.isTripped(state, Date.now()) || laneOwnsCompaction;
		if (
			!laneOwnsCompaction &&
			usage &&
			policy.isAtHardLimit(usage, contextWindow, settings.reserveTokens, pendingPromptTokens)
		) {
			getLogger(ctx).debug("hard_limit_trigger", {
				contextWindow,
				tokens: usage.tokens ?? 0,
				threshold: settings.reserveTokens,
			});
			await applyBlockingCompaction(ctx, EMERGENCY_COMPACTION_INSTRUCTIONS);
		} else if (
			!breakerCoolingDown &&
			usageWithPendingPrompt &&
			policy.shouldTriggerCompaction(usageWithPendingPrompt, contextWindow, settings, state.lastYield ?? undefined)
		) {
			getLogger(ctx).debug("threshold_trigger", {
				contextWindow,
				tokens: usageWithPendingPrompt.tokens ?? 0,
				threshold: settings.reserveTokens,
			});
			await applyBlockingCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS);
		} else if (
			!breakerCoolingDown &&
			usageWithPendingPrompt &&
			policy.shouldStartSpeculativeCompaction(
				usageWithPendingPrompt,
				contextWindow,
				settings,
				state.lastYield ?? undefined,
			)
		) {
			getLogger(ctx).debug("emergency_prune", {
				route: "context-event",
				tokens: usageWithPendingPrompt.tokens ?? 0,
			});
			startSpeculativeCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS);
		}

		return message ? { message } : undefined;
	});

	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const promptContextWindow = getPromptContextWindow(contextWindow, ctx.model?.maxTokens);
		const sourceMessages = shouldApplyContextReduction({
			usageTokens: usage?.tokens ?? null,
			contextWindow,
			isProviderNativeCompactionPath:
				isOpenAiRemoteCompactionModel(ctx.model) || lanePolicy.disablesSenpiCompaction(ctx),
		})
			? reduceContextMessages(event.messages, BUILTIN_CONTEXT_REDUCTION_OPTIONS).messages
			: event.messages;
		// The claude-sdk-oauth lane stands down from senpi compaction entirely:
		// destructively pruning the provider context near the hard limit would
		// break the resident SDK session's continuity the same way the gated
		// reduction lane would.
		const emergency = lanePolicy.disablesSenpiCompaction(ctx)
			? { messages: sourceMessages, needsAggressiveCompaction: false }
			: hardLimitEmergencyPrune(sourceMessages, promptContextWindow, emergencyPruneLatch);
		const marked = markOpenAiRemoteReplayBoundary(emergency.messages, {
			model: ctx.model,
			branchEntries: ctx.sessionManager.getBranch(),
		});
		return { messages: repairOrphanedToolResults(convertToLlm(marked)) };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = event.model ?? ctx.model;
		if (!isOpenAiRemoteCompactionModel(model)) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;
		const effectiveModel =
			auth.upstreamModelId || auth.baseUrl
				? {
						...model,
						...(auth.upstreamModelId ? { id: auth.upstreamModelId } : {}),
						...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
					}
				: model;
		const headers = createOpenAiRemoteCompactionHeaders(
			effectiveModel,
			{ ...auth, headers: event.headers ?? auth.headers },
			ctx.sessionManager.getSessionId(),
		);
		if (!headers) return undefined;
		const origin = openAiRemoteCompactionOrigin(effectiveModel, headers);
		return rewriteOpenAiPayloadWithRemoteCompaction(
			event.payload,
			{ model: effectiveModel, branchEntries: ctx.sessionManager.getBranch(), origin },
			(data) => pi.events.emit(SENPI_COMPACTION_EVENT, data),
		);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (lanePolicy.disablesSenpiCompaction(ctx)) return;
		handleTurnEnd(degradationState);
		if (degradationState.recoveryTriggeredThisCycle) return;
		if (state.lastYield && state.lastYield.savedTokens <= 0) {
			void applyBlockingCompaction(ctx, RECOVERY_INSTRUCTIONS).catch(() => {});
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		state = resetTurnCounter(state, "");
		if (lanePolicy.disablesSenpiCompaction(ctx)) return;
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const settings = ctx.getCompactionSettings();
		if (
			idle.shouldRunIdleCompaction({
				willRetry: event.willRetry ?? false,
				aborted: event.aborted === true,
				settings,
				usage,
				contextWindow,
				breakerTripped: breaker.isTripped(state, Date.now()),
				lastYield: state.lastYield ?? undefined,
				mode: ctx.mode,
			})
		) {
			getLogger(ctx).debug("idle_trigger", { contextWindow, tokens: usage?.tokens ?? 0 });
			startSpeculativeCompaction(ctx, idle.IDLE_COMPACTION_INSTRUCTIONS);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		for (const entry of collectCompactBoundaryEntries(event.message)) {
			pi.appendEntry(CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE, entry);
		}
		if (isAbortedAssistantMessage(event)) {
			invalidateSpeculativeCompaction(ctx);
		}
		if (isMonitorableMessageEvent(event) && !lanePolicy.disablesSenpiCompaction(ctx)) {
			await handleMessageEnd(degradationState, event, {
				applyCompaction: async (options) => {
					return await applyBlockingCompaction(ctx, options.customInstructions);
				},
				notify: (message) => ctx.ui.notify(message, "warning"),
			});
		}
	});

	pi.on("tool_call", (event) => {
		restoration.trackToolCall(restorationState, event);
	});
}
