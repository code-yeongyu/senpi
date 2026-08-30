import type { Tool } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../../compaction/index.ts";
import { createWarmAnchorSnapshot, isWarmSummaryAnchorValid } from "../../../compaction/warm-anchor.ts";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionCompactEvent } from "../../types.ts";
import * as checkpointState from "./checkpoint-state.ts";
import * as breaker from "./circuit-breaker.ts";
import { buildCompactionContext } from "./context-pipeline.ts";
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
import * as idleRetry from "./idle-retry.ts";
import {
	CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE,
	collectCompactBoundaryEntries,
	createCompactionLanePolicy,
	SDK_NATIVE_LANE_REJECTION_REASON,
} from "./lane-policy.ts";
import { type CompactionLogger, createCompactionLogger } from "./log.ts";
import { handleCompactionModelSelect } from "./model-selection.ts";
import {
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
import {
	resolveBeforeAgentStartMessage,
	resolveCompactionGeometry,
	resolveIdleWarmAction,
	resolveReminderSystemPrompt,
	shouldDeferGraceBand,
} from "./orchestration.ts";
import * as cap from "./per-turn-cap.ts";
import * as policy from "./policy.ts";
import * as restoration from "./restoration-tracker.ts";
import {
	applyGeneratedCompaction,
	createEmergencyPruneLatch,
	createSpeculativeCompactionSnapshot,
	getPromptVariant,
	runExtensionCompaction,
	type SpeculativeCompactionResult,
	type SpeculativeCompactionSnapshot,
	SummaryGenerationError,
} from "./speculative.ts";
import { type SpeculativeJob, trackSpeculativeJob } from "./speculative-job.ts";
import { type CompactionExtensionState, createInitialState, resetTurnCounter } from "./state.ts";
import { resolveInheritedTaskIntent } from "./task-intent.ts";
import * as todoBridge from "./todo-bridge.ts";
import {
	computeTokenBudgetReminder,
	createInitialReminderState,
	type TokenBudgetReminderState,
} from "./token-budget-reminder.ts";
import { isTransientSummarizationFailure } from "./transient-failure.ts";

export { getPromptContextWindow } from "./extension-wiring.ts";

import {
	createBlockingRemoteCompactionEvent,
	endCompactionFeedback,
	estimatePendingPromptTokens,
	getPromptContextWindow,
	isAbortedAssistantMessage,
	isMonitorableMessageEvent,
	isRequiredCompactionFallbackReason,
	linkAbortSignal,
	recentCheckpoint,
	withAdditionalTokens,
} from "./extension-wiring.ts";
import { isIneffectiveCompaction } from "./yield.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const EMERGENCY_COMPACTION_INSTRUCTIONS =
	"EMERGENCY: hard context limit reached. Produce an aggressive recovery summary that preserves current goal, constraints, files touched, tool outcomes, and exact next steps. Prefer concise factual state over transcript detail.";
const PROACTIVE_COMPACTION_INSTRUCTIONS = "Proactively compact before the next agent turn.";
const MAX_PENDING_METADATA = 8;

interface PendingCompactionMetadata {
	checkpoint: checkpointState.AgentCheckpoint;
	todoSnapshot: todoBridge.TodoSnapshotPayload;
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
	let reminderState: TokenBudgetReminderState = createInitialReminderState();
	let speculativeJob: SpeculativeJob | undefined;
	const pendingMetadata = new Map<string, PendingCompactionMetadata>();
	let logger: CompactionLogger | undefined;
	const getLogger = (ctx: ExtensionContext): CompactionLogger => (logger ??= createCompactionLogger(ctx.agentDir));

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

	let idleWarmupTimer: ReturnType<typeof setTimeout> | undefined;
	let idleWarmupAttempt = 0;
	// True from the `agent_end` idle trigger until the next turn starts (or the
	// session shuts down). The idle-apply watcher below is fenced on it so a
	// summary that lands after the user has already prompted is never applied
	// out from under the turn that is starting; the warm-consume path in
	// `before_agent_start` owns the job from that point on.
	let sessionIdleSinceAgentEnd = false;

	function cancelIdleWarmupRetry(): void {
		if (idleWarmupTimer === undefined) return;
		clearTimeout(idleWarmupTimer);
		idleWarmupTimer = undefined;
	}

	// A session reload retires this extension generation while the warm-up
	// watcher below is still armed: `AgentSession.reload()` invalidates the old
	// runner, after which every `ExtensionContext` getter throws
	// "stale extension generation after reload". The watcher outlives that
	// invalidation in two places — the `job.failure` continuation and the armed
	// retry timer — and neither had a caller left to receive the throw: the
	// continuation is spawned with `void` (unhandled rejection) and the timer
	// callback throws straight into the timer queue, which terminates the
	// process. The context carries no liveness flag, so a retired generation is
	// only observable by reading a getter and catching the assertion.
	function isContextRetired(ctx: ExtensionContext): boolean {
		try {
			ctx.isIdle();
			return false;
		} catch {
			return true;
		}
	}

	// Fenced on the observed job: a prompt, invalidation, a reload, or a newer
	// warm-up stands this watcher down before it can start a duplicate
	// summarization.
	function armIdleWarmupRetry(ctx: ExtensionContext): void {
		const job = speculativeJob;
		if (!job) return;
		void job.failure.then((failure) => {
			if (failure === undefined) {
				idleWarmupAttempt = 0;
				return;
			}
			if (speculativeJob !== job) return;
			// A reload between arming and this continuation retires the context.
			if (isContextRetired(ctx)) {
				cancelIdleWarmupRetry();
				return;
			}
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
			const settings = ctx.getCompactionSettings();
			const breakerTripped = breaker.isTripped(state, Date.now());
			const retryDecision: idleRetry.IdleWarmupRetryDecision = {
				attempt: idleWarmupAttempt,
				transient: isTransientSummarizationFailure(failure, failure.message),
				isIdle: ctx.isIdle(),
				breakerTripped,
				stillWarmEligible: idle.shouldWarmAtIdle({
					willRetry: false,
					aborted: false,
					settings,
					usage,
					contextWindow,
					breakerTripped,
					lastYield: state.lastYield ?? undefined,
					mode: ctx.mode,
				}),
			};
			if (!idleRetry.shouldRetryIdleWarmup(retryDecision)) return;
			cancelIdleWarmupRetry();
			idleWarmupTimer = setTimeout(() => {
				idleWarmupTimer = undefined;
				if (speculativeJob !== job) return;
				// The reload may land after the timer was armed; a throw here would
				// escape into the timer queue as an uncaughtException.
				if (isContextRetired(ctx)) return;
				if (!ctx.isIdle()) return;
				idleWarmupAttempt += 1;
				getLogger(ctx).debug("idle_trigger", {
					contextWindow,
					tokens: usage?.tokens ?? 0,
					count: idleWarmupAttempt,
				});
				invalidateSpeculativeCompaction(ctx);
				startSpeculativeCompaction(ctx, idle.IDLE_COMPACTION_INSTRUCTIONS);
				armIdleWarmupRetry(ctx);
				armIdleApply(ctx);
			}, idleRetry.IDLE_WARMUP_RETRY_DELAY_MS);
		});
	}

	/**
	 * Apply the idle warm summary as soon as it finishes generating, while the
	 * session is still idle. Holding it warm until the next `before_agent_start`
	 * makes the user watch their own prompt wait behind a compaction they could
	 * not see coming; applying during the idle gap renders the [compaction] block
	 * first and lets the next message stack below it.
	 *
	 * Every guard is re-read at continuation time, because generation takes long
	 * enough for all of them to change: the session may no longer be idle, the
	 * job may have been invalidated or claimed, the context may have dropped
	 * below the threshold, the lane may have been handed to the SDK, or the
	 * breaker may have tripped. A refused apply (stale anchor/revision) silently
	 * keeps the warm hold, so the next prompt consumes it exactly as before.
	 */
	function armIdleApply(ctx: ExtensionContext): void {
		const job = speculativeJob;
		if (!job) return;
		// Never throws out of the continuation: a retired context, a refused apply,
		// or a provider failure all resolve into a silent stand-down.
		void job.promise
			.then(async (compaction) => {
				if (!compaction) return;
				if (speculativeJob !== job) return;
				if (!sessionIdleSinceAgentEnd) return;
				if (isContextRetired(ctx)) return;
				if (!ctx.isIdle()) return;
				if (lanePolicy.disablesSenpiCompaction(ctx)) return;
				if (breaker.isTripped(state, Date.now())) return;
				if (cap.shouldRejectByCap(state).cancel) return;
				const usage = ctx.getContextUsage();
				const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
				if (
					!usage ||
					!policy.shouldTriggerCompaction(
						usage,
						contextWindow,
						ctx.getCompactionSettings(),
						state.lastYield ?? undefined,
					)
				) {
					return;
				}
				const result = await applyGeneratedCompaction(ctx, job.snapshot, () => speculativeGeneration, compaction);
				if (!result.applied) return;
				// The job is consumed: clearing it here is also what stands the idle
				// retry watcher down for this generation.
				if (speculativeJob === job) speculativeJob = undefined;
				cancelIdleWarmupRetry();
				getLogger(ctx).debug("idle_applied", { generation: job.generation, origin: "speculative" });
			})
			.catch(() => {});
	}

	function isSameModelIdentity(
		left: SpeculativeCompactionSnapshot["model"],
		right: ExtensionContext["model"],
	): boolean {
		return (
			right !== undefined &&
			left.api === right.api &&
			left.provider === right.provider &&
			left.id === right.id &&
			left.baseUrl === right.baseUrl &&
			left.contextWindow === right.contextWindow
		);
	}

	/**
	 * Detach the warm job for the core route before any `await`, so exactly one
	 * claimant can own it. The controller is deliberately NOT aborted: the whole
	 * point is to keep the already-paid summarization alive and hand its result to
	 * core, and clearing the reference is what stands the idle-retry watcher down.
	 */
	function claimWarmSummaryForCoreRoute(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	): typeof speculativeJob {
		const job = speculativeJob;
		if (!job) return undefined;
		if (event.customInstructions !== undefined) return undefined;
		if (job.snapshot.origin !== "speculative") return undefined;
		if (job.snapshot.preparation.firstKeptEntryId !== event.preparation.firstKeptEntryId) return undefined;
		if (!isSameModelIdentity(job.snapshot.model, ctx.model)) return undefined;
		const anchor = createWarmAnchorSnapshot(
			job.snapshot.preparation.firstKeptEntryId,
			job.snapshot.branchEntries ?? [],
		);
		if (!anchor || !isWarmSummaryAnchorValid(anchor, event.branchEntries ?? ctx.sessionManager.getBranch())) {
			return undefined;
		}
		speculativeJob = undefined;
		return job;
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
		speculativeJob = trackSpeculativeJob({
			generation,
			snapshot,
			controller,
			settled,
			armedAtTokens: ctx.getContextUsage()?.tokens ?? 0,
		});
		void settled.then(() => remoteCompactionDependencies.onSpeculativeJobSettled?.());
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
		const provider = ctx.model?.provider;
		if ((provider === "cursor" || provider === "cursor-cli-oauth") && !ctx.isIdle()) {
			getLogger(ctx).debug("skip_cursor_mid_turn", { route: "blocking" });
			return { applied: false, reason: "rejected" };
		}
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
			let remoteFallbackReason: string | undefined;
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
						(data) => {
							if (data?.action === "remote_fallback" && typeof data.reason === "string") {
								remoteFallbackReason = data.reason;
							}
							pi.events.emit(SENPI_COMPACTION_EVENT, data);
						},
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
				if (result.applied) {
					speculativeJob = undefined;
					getLogger(ctx).debug("speculative_applied", {
						generation: pendingJob.generation,
						origin: "speculative",
					});
					endCompactionFeedback(ctx, feedbackSignal, result);
					return result;
				}
				if (result.reason === "stale") {
					getLogger(ctx).debug("speculative_stale", { generation: pendingJob.generation });
				} else if (result.reason === "rejected") {
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
				endCompactionFeedback(ctx, feedbackSignal, result, remoteFallbackReason);
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
			endCompactionFeedback(ctx, feedbackSignal, result, remoteFallbackReason);
			return result;
		} catch (error) {
			if (feedbackSignal?.aborted) {
				// An aborted blocking compaction is a cancellation, not a failure: no
				// red "Compaction failed" line, no breaker debit, no rethrow through
				// the before_agent_start handler (issue #886). The faux-route flavor
				// of this contract is pinned by blocking-compaction-review-hardening.
				getLogger(ctx).debug("blocking_aborted", { route: "blocking" });
				ctx.endCompaction?.({ reason: "extension", signal: feedbackSignal, aborted: true });
				return { applied: false, reason: "rejected" };
			}
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
		// A pre-aborted request (superseded admission or user cancel) must stand
		// down before touching warm-job ownership: core's own post-emit abort
		// checks turn it into a clean cancellation (issue #886).
		if (event.signal.aborted) return undefined;
		const claimedWarmJob = claimWarmSummaryForCoreRoute(event, ctx);
		// The claim detaches the job without aborting it, so ownership must survive every
		// exit from this handler - including a throw - or the request it already paid for
		// keeps streaming for a result nobody will read.
		let warmJobConsumed = false;
		invalidateSpeculativeCompaction(ctx);
		try {
			if (lanePolicy.disablesSenpiCompaction(ctx)) {
				return {
					cancel: true,
					rejectionCause: "external-owner",
					reason: SDK_NATIVE_LANE_REJECTION_REASON,
				};
			}
			if (cap.shouldRejectByCap(state).cancel) {
				getLogger(ctx).debug("skip_cap", { reason: event.reason, count: state.acceptedAbsolute });
				return {
					cancel: true,
					rejectionCause: "per-turn-cap",
					reason: "absolute compaction cap reached for this session",
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
			if (!model) {
				return undefined;
			}
			let remoteCompaction: Awaited<ReturnType<typeof runOpenAiRemoteCompaction>>;
			try {
				remoteCompaction = await runOpenAiRemoteCompaction(
					ctx,
					event,
					(data) => pi.events.emit(SENPI_COMPACTION_EVENT, data),
					remoteCompactionDependencies,
				);
			} catch (error) {
				// The remote route deliberately rethrows once its signal aborts; the
				// handler converts that into a silent stand-down so the abort is not
				// reported as an extension error with a stack (issue #886).
				if (!event.signal.aborted) throw error;
				getLogger(ctx).debug("remote_aborted", { route: "core-route", requestId: event.requestId });
				return undefined;
			}
			if (remoteCompaction) {
				getLogger(ctx).debug("core_route_generated", { route: "core-route", requestId: event.requestId });
				return { compaction: remoteCompaction };
			}

			if (claimedWarmJob) {
				const unlinkAbort = linkAbortSignal(event.signal, claimedWarmJob.controller);
				let warmCompaction: CompactionResult | undefined;
				let warmFailure: Error | undefined;
				try {
					warmCompaction = await claimedWarmJob.promise;
					warmFailure = await claimedWarmJob.failure;
				} finally {
					unlinkAbort();
				}
				if (warmFailure === undefined && warmCompaction && !event.signal.aborted) {
					getLogger(ctx).debug("warm_consumed", { generation: claimedWarmJob.generation, route: "core-route" });
					warmJobConsumed = true;
					return { compaction: warmCompaction };
				}
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
				if (
					isRequiredCompactionFallbackReason(event.reason) &&
					failureKind !== undefined &&
					!event.signal.aborted
				) {
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
		} finally {
			if (!warmJobConsumed) claimedWarmJob?.controller.abort();
		}
	});

	pi.on("model_select", (event, ctx) =>
		handleCompactionModelSelect({
			event,
			ctx,
			state,
			speculativeSnapshot: speculativeJob?.snapshot,
			laneOwnsCompaction: lanePolicy.disablesSenpiCompaction(ctx),
			breakerTripped: breaker.isTripped(state, Date.now()),
			invalidate: () => invalidateSpeculativeCompaction(ctx),
			start: () => startSpeculativeCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS),
		}),
	);

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
			reminderState = createInitialReminderState();
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
					reserveTokens: policy.resolveEffectiveReserveTokens(
						usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
						settings,
					),
					settings,
					keptMessages: keptEntries.flatMap((entry) => {
						if (entry.type !== "message") return [];
						return [entry.message];
					}),
				});
			}
			return;
		}
		if (compactEvent.rejectionCause === "external-owner") return;
		if (!lanePolicy.disablesSenpiCompaction(ctx)) {
			state = breaker.recordFailure(state, Date.now(), { route: compactEvent.reason });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		sessionIdleSinceAgentEnd = false;
		cancelIdleWarmupRetry();
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
		const { reserveTokens, thresholdTokens, leadTokens } = resolveCompactionGeometry({
			contextWindow,
			settings,
			lastYield: state.lastYield ?? undefined,
		});
		if (
			!laneOwnsCompaction &&
			usage &&
			policy.isAtHardLimit(usage, contextWindow, reserveTokens, pendingPromptTokens)
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
			if (
				!shouldDeferGraceBand({
					tokens: usageWithPendingPrompt.tokens ?? 0,
					thresholdTokens,
					leadTokens,
					contextWindow,
					reserveTokens,
					compactionInFlight: speculativeJob !== undefined && !speculativeJob.completed,
					graceBandEnabled: settings.graceBandEnabled,
				})
			) {
				await applyBlockingCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS);
			} else {
				getLogger(ctx).debug("grace_deferred", {
					tokens: usageWithPendingPrompt.tokens ?? 0,
					threshold: thresholdTokens,
				});
			}
		} else if (
			!breakerCoolingDown &&
			!isOpenAiRemoteCompactionModel(ctx.model) &&
			usageWithPendingPrompt &&
			policy.shouldStartSpeculativeCompaction(
				usageWithPendingPrompt,
				contextWindow,
				settings,
				state.lastYield ?? undefined,
				leadTokens,
			)
		) {
			getLogger(ctx).debug("emergency_prune", {
				route: "context-event",
				tokens: usageWithPendingPrompt.tokens ?? 0,
			});
			startSpeculativeCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS);
		}

		const reminder = computeTokenBudgetReminder({
			contextTokens: usageWithPendingPrompt?.tokens ?? 0,
			contextWindow,
			thresholdTokens,
			leadTokens,
			compactionEpoch: speculativeGeneration,
			state: reminderState,
		});
		reminderState = reminder.nextState;
		const deliveredMessage = resolveBeforeAgentStartMessage({
			message,
			reminder: reminder.message,
			reminderEnabled: settings.reminderEnabled,
		});
		const reminderSystemPrompt = resolveReminderSystemPrompt({
			systemPrompt: event.systemPrompt,
			reminder: !message ? reminder.message : undefined,
			reminderEnabled: settings.reminderEnabled,
		});
		if (!deliveredMessage && !reminderSystemPrompt) return undefined;
		return {
			...(deliveredMessage ? { message: deliveredMessage } : {}),
			...(reminderSystemPrompt ? { systemPrompt: reminderSystemPrompt } : {}),
		};
	});

	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		const settings = ctx.getCompactionSettings();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const laneOwnsCompaction = lanePolicy.disablesSenpiCompaction(ctx);
		const breakerFallback =
			!laneOwnsCompaction &&
			breaker.isTripped(state, Date.now()) &&
			usage?.tokens !== null &&
			usage !== undefined &&
			usage.tokens >= contextWindow * policy.computeEffectiveThreshold(contextWindow, state.lastYield ?? undefined);
		if (breakerFallback)
			getLogger(ctx).debug("breaker_deterministic_fallback", { route: "context-event", tokens: usage.tokens ?? 0 });
		return {
			messages: buildCompactionContext({
				event,
				ctx,
				contextWindow,
				promptContextWindow: getPromptContextWindow(contextWindow, ctx.model?.maxTokens),
				toolAdmissionEnabled: settings.toolAdmissionEnabled !== false,
				breakerFallback,
				laneOwnsCompaction,
				emergencyPruneLatch,
			}),
		};
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
		try {
			if (lanePolicy.disablesSenpiCompaction(ctx)) return;
			handleTurnEnd(degradationState);
			if (degradationState.recoveryTriggeredThisCycle) return;
			if (state.lastYield && state.lastYield.savedTokens <= 0) {
				void applyBlockingCompaction(ctx, RECOVERY_INSTRUCTIONS).catch(() => {});
			}
		} finally {
			state = resetTurnCounter(state, "");
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
			idleWarmupAttempt = 0;
			sessionIdleSinceAgentEnd = true;
			startSpeculativeCompaction(ctx, idle.IDLE_COMPACTION_INSTRUCTIONS);
			armIdleWarmupRetry(ctx);
			armIdleApply(ctx);
		} else {
			// A sub-threshold OpenAI warm-up cannot be consumed by the remote
			// compaction route. Once threshold admission succeeds remotely, it would
			// only abort and discard this paid local summary. Above threshold we keep
			// the existing local idle apply, which can finish before the next prompt;
			// if remote compaction later falls back, blocking local generation remains
			// unchanged.
			if (isOpenAiRemoteCompactionModel(ctx.model)) return;
			const warmAction = resolveIdleWarmAction(
				{
					willRetry: event.willRetry ?? false,
					aborted: event.aborted === true,
					settings,
					usage,
					contextWindow,
					breakerTripped: breaker.isTripped(state, Date.now()),
					lastYield: state.lastYield ?? undefined,
					mode: ctx.mode,
				},
				speculativeJob,
			);
			if (warmAction === "replace") invalidateSpeculativeCompaction(ctx);
			if (warmAction !== "none") {
				idleWarmupAttempt = 0;
				sessionIdleSinceAgentEnd = true;
				startSpeculativeCompaction(ctx, idle.IDLE_COMPACTION_INSTRUCTIONS);
				armIdleWarmupRetry(ctx);
				armIdleApply(ctx);
			}
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

	// The reload path retires this extension generation right after this event
	// (`AgentSession.reload()` invalidates the old runner), so stand the idle
	// warm-up watcher down here rather than leaving a timer armed against a
	// context that is about to start throwing on every read.
	pi.on("session_shutdown", () => {
		sessionIdleSinceAgentEnd = false;
		cancelIdleWarmupRetry();
		idleWarmupAttempt = 0;
		speculativeJob?.controller.abort();
		speculativeJob = undefined;
	});
}
