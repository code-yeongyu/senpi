import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CompactionResult, DEFAULT_COMPACTION_SETTINGS } from "../../../compaction/index.js";
import { convertToLlm } from "../../../messages.js";
import type { CompactionEntry } from "../../../session-manager.js";
import type { ExtensionAPI, ExtensionContext } from "../../types.js";
import * as checkpointState from "./checkpoint-state.js";
import * as breaker from "./circuit-breaker.js";
import {
	createDegradationMonitorState,
	handleMessageEnd,
	handleTurnEnd,
	RECOVERY_INSTRUCTIONS,
	resetOnSessionCompact,
} from "./degradation-monitor.js";
import {
	rewriteOpenAiPayloadWithRemoteCompaction,
	runOpenAiRemoteCompaction,
	SENPI_COMPACTION_EVENT,
} from "./openai-remote.js";
import * as overflow from "./overflow-detection.js";
import * as cap from "./per-turn-cap.js";
import * as policy from "./policy.js";
import { repairOrphanedToolResults } from "./repair-tool-pairs.js";
import * as restoration from "./restoration-tracker.js";
import {
	applyGeneratedCompaction,
	createSpeculativeCompactionSnapshot,
	getPromptVariant,
	hardLimitEmergencyPrune,
	runExtensionCompaction,
	type SpeculativeCompactionResult,
	type SpeculativeCompactionSnapshot,
} from "./speculative.js";
import { type CompactionExtensionState, createInitialState, resetTurnCounter } from "./state.js";
import * as todoBridge from "./todo-bridge.js";
import * as truncation from "./tool-truncation.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const EMERGENCY_COMPACTION_INSTRUCTIONS =
	"EMERGENCY: hard context limit reached. Produce an aggressive recovery summary that preserves current goal, constraints, files touched, tool outcomes, and exact next steps. Prefer concise factual state over transcript detail.";
const PROACTIVE_COMPACTION_INSTRUCTIONS = "Proactively compact before the next agent turn.";
const MAX_PENDING_METADATA = 8;

interface PendingCompactionMetadata {
	checkpoint: checkpointState.AgentCheckpoint;
	todoSnapshot: todoBridge.TodoSnapshotPayload;
}

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function isMonitorableMessageEvent(event: { message: AgentMessage }): event is {
	message: AgentMessage & { content: Array<{ type: string; text?: string }> };
} {
	return "content" in event.message && Array.isArray(event.message.content);
}

function updateLastYield(state: CompactionExtensionState, entry: CompactionEntry): CompactionExtensionState {
	const savedTokens = Math.max(0, entry.tokensBefore - approxTokens(entry.summary));
	return { ...state, lastYield: { savedTokens, tokensBefore: entry.tokensBefore } };
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
		ctx.endCompaction?.({ reason: "extension", aborted: signal?.aborted });
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

export default function compactionExtension(pi: ExtensionAPI): void {
	let state: CompactionExtensionState = createInitialState();
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
		  }
		| undefined;
	const pendingMetadata = new Map<string, PendingCompactionMetadata>();

	function invalidateSpeculativeCompaction(): void {
		speculativeGeneration++;
		speculativeJob?.controller.abort();
		speculativeJob = undefined;
	}

	function startSpeculativeCompaction(ctx: ExtensionContext, customInstructions: string): void {
		if (speculativeJob) return;
		const generation = ++speculativeGeneration;
		const snapshot = createSpeculativeCompactionSnapshot(ctx, { generation, customInstructions });
		if (!snapshot) return;

		const controller = new AbortController();
		const promise = runExtensionCompaction(ctx, snapshot, controller.signal).catch(() => undefined);
		speculativeJob = { generation, snapshot, controller, promise };
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
		let feedbackSignal = ctx.beginCompaction?.({ reason: "extension" });
		try {
			const pendingJob = speculativeJob;
			if (pendingJob) {
				const unlinkAbort = linkAbortSignal(feedbackSignal, pendingJob.controller);
				let compaction: CompactionResult | undefined;
				try {
					compaction = await pendingJob.promise;
				} finally {
					unlinkAbort();
				}
				const result = await applyGeneratedCompaction(
					ctx,
					pendingJob.snapshot,
					() => speculativeGeneration,
					compaction,
				);
				if (result.applied || result.reason === "stale") {
					speculativeJob = undefined;
					endCompactionFeedback(ctx, feedbackSignal, result);
					return result;
				}
				if (result.reason === "rejected") {
					feedbackSignal = ctx.beginCompaction?.({ reason: "extension" });
				}
				speculativeJob = undefined;
			}

			const generation = ++speculativeGeneration;
			const snapshot = createSpeculativeCompactionSnapshot(ctx, { generation, customInstructions });
			if (!snapshot) {
				const result = { applied: false, reason: "unavailable" } as const;
				endCompactionFeedback(ctx, feedbackSignal, result);
				return result;
			}
			const compaction = await runExtensionCompaction(ctx, snapshot, feedbackSignal);
			const result = await applyGeneratedCompaction(ctx, snapshot, () => speculativeGeneration, compaction);
			endCompactionFeedback(ctx, feedbackSignal, result);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.endCompaction?.({
				reason: "extension",
				aborted: feedbackSignal?.aborted,
				errorMessage: `Compaction failed: ${message}`,
			});
			throw error;
		}
	}

	pi.on("session_before_compact", async (event, ctx) => {
		invalidateSpeculativeCompaction();
		if (cap.shouldRejectByCap(state, { reason: event.reason }).cancel) return { cancel: true };
		if (breaker.isTripped(state, Date.now()) && !breaker.shouldBypass(state, { reason: event.reason }))
			return { cancel: true };

		capturePendingMetadata(event.requestId, ctx);

		const model = ctx.model;
		if (!model) return undefined;
		const remoteCompaction = await runOpenAiRemoteCompaction(ctx, event, (data) =>
			pi.events.emit(SENPI_COMPACTION_EVENT, data),
		);
		if (remoteCompaction) {
			return { compaction: remoteCompaction };
		}

		const snapshot = {
			generation: ++speculativeGeneration,
			expectedRevision: ctx.getMessageRevision(),
			model,
			contextWindow: ctx.getContextUsage()?.contextWindow ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			preparation: event.preparation,
			promptVariant: getPromptVariant(event),
			customInstructions: event.customInstructions,
		};
		const compaction = await runExtensionCompaction(ctx, snapshot, event.signal);
		if (!compaction) {
			pendingMetadata.delete(event.requestId);
			return { cancel: true };
		}

		return {
			compaction,
		};
	});

	pi.on("session_compact", async (event, ctx) => {
		invalidateSpeculativeCompaction();
		if (event.accepted) {
			persistAcceptedMetadata(event.requestId);
			const branchEntries = ctx.sessionManager.getBranch();
			const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === event.compactionEntry.firstKeptEntryId);
			const keptEntries = firstKeptIndex === -1 ? [] : branchEntries.slice(firstKeptIndex);
			state = cap.incrementAccepted(state);
			state = breaker.recordSuccess(state);
			state = updateLastYield(state, event.compactionEntry);
			resetOnSessionCompact(degradationState);
			todoBridge.restoreTodosIfMissing(pi, ctx);
			const usage = ctx.getContextUsage();
			if (DEFAULT_COMPACTION_SETTINGS.restorationEnabled) {
				restoration.preparePendingPayload(restorationState, {
					accepted: true,
					reason: event.reason,
					compactionEntryId: event.compactionEntry.id,
					contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
					usageTokens: usage?.tokens ?? null,
					reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
					settings: DEFAULT_COMPACTION_SETTINGS,
					keptMessages: keptEntries.flatMap((entry) => {
						if (entry.type !== "message") return [];
						return [entry.message];
					}),
				});
			}
			return;
		}
		state = breaker.recordFailure(state, Date.now(), { route: event.reason });
		ctx.ui.notify(`Compaction rejected: ${event.rejectionCause ?? "unknown"}`, "warning");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let systemPrompt = event.systemPrompt;
		const message = restoration.consumePendingPayload(restorationState);
		const checkpoint = recentCheckpoint(ctx);
		if (checkpoint) systemPrompt = checkpointState.injectRestorationDirective(systemPrompt, checkpoint);

		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const settings = ctx.getCompactionSettings();
		if (usage && policy.isAtHardLimit(usage, contextWindow, settings.reserveTokens)) {
			await applyBlockingCompaction(ctx, EMERGENCY_COMPACTION_INSTRUCTIONS);
		} else if (
			usage &&
			policy.shouldTriggerCompaction(usage, contextWindow, settings, state.lastYield ?? undefined)
		) {
			await applyBlockingCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS);
		} else if (
			usage &&
			policy.shouldStartSpeculativeCompaction(usage, contextWindow, settings, state.lastYield ?? undefined)
		) {
			startSpeculativeCompaction(ctx, PROACTIVE_COMPACTION_INSTRUCTIONS);
		}

		if (systemPrompt === event.systemPrompt && !message) return undefined;
		return message ? { systemPrompt, message } : { systemPrompt };
	});

	pi.on("context", (event, ctx) => {
		const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const emergency = hardLimitEmergencyPrune(event.messages, contextWindow);
		return { messages: repairOrphanedToolResults(convertToLlm(emergency.messages)) };
	});

	pi.on("before_provider_request", (event, ctx) => {
		return rewriteOpenAiPayloadWithRemoteCompaction(
			event.payload,
			{ model: ctx.model, branchEntries: ctx.sessionManager.getBranch() },
			(data) => pi.events.emit(SENPI_COMPACTION_EVENT, data),
		);
	});

	pi.on("turn_end", async (_event, ctx) => {
		handleTurnEnd(degradationState);
		if (degradationState.recoveryTriggeredThisCycle) return;
		if (state.lastYield && state.lastYield.savedTokens <= 0) {
			void applyBlockingCompaction(ctx, RECOVERY_INSTRUCTIONS);
		}
	});

	pi.on("agent_end", () => {
		state = resetTurnCounter(state, "");
	});

	pi.on("message_end", async (event, ctx) => {
		if (isMonitorableMessageEvent(event)) {
			await handleMessageEnd(degradationState, event, {
				applyCompaction: async (options) => {
					return await applyBlockingCompaction(ctx, options.customInstructions);
				},
				notify: (message) => ctx.ui.notify(message, "warning"),
			});
		}
		if (event.message.role === "assistant" && event.message.stopReason === "error") {
			const detected = overflow.isContextOverflowError(new Error(event.message.errorMessage ?? ""));
			if (detected.detected) {
				void applyBlockingCompaction(ctx, `RECOVERY: context overflow detected (${detected.confidence})`);
			}
		}
	});

	pi.on("tool_result", (event) => {
		const [truncated] = truncation.truncateOversizedToolResults([{ content: event.content, details: event.details }]);
		return truncated ? { content: truncated.content, details: event.details, isError: event.isError } : undefined;
	});

	pi.on("tool_call", (event) => {
		restoration.trackToolCall(restorationState, event);
	});
}
