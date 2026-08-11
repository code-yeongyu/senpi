import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	isTerminalMonitorStateEvent,
	isWakeSourceStateEvent,
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../monitor-state-event.ts";
import {
	estimateCacheWarmMetrics,
	GOAL_CACHE_WARMUP_ENTRY_TYPE,
	GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS,
	type GoalCacheWarmMetrics,
	type GoalCacheWarmupEntryData,
	type LiveGoalCacheWarmupEntryData,
	resolveGoalMonitorContinuationDelayMs,
} from "./cache-warm.ts";

export { GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS } from "./cache-warm.ts";

import {
	continuationTurnUsedTools,
	evaluateGoalContinuation,
	GOAL_USER_GRACE_DELAY_MS,
	type GoalContinuationInput,
	type GoalContinuationPath,
	hasGoalContinuationProgress,
	hashAssistantText,
	normalizeAssistantText,
} from "./continuation.ts";
import { lastAssistantMessage } from "./last-assistant-message.ts";
import {
	admitAndQueueGoalContinuation,
	buildCurrentGoalContinuationSignature,
	lastAssistantText,
} from "./lifecycle-helpers.ts";
import type {
	AgentEndOptions,
	ContinuingGoalContinuationVerdict,
	DelayedContinuationKind,
	GoalContinuationAdmission,
	ResumptionChannelCounts,
	SystemAbortOptions,
} from "./monitor-continuation-types.ts";
import { buildContinuationPrompt, buildGoalStallNotice, buildTruncationRecoveryPrompt } from "./prompt.ts";
import { resetContinuationStreak } from "./store.ts";
import { goalStoreRef } from "./store-ref.ts";
import { collectAssistantUsage } from "./turn-usage.ts";
import type { Goal, TokenUsageSnapshot } from "./types.ts";
import type { GoalWaitTicker } from "./wait-ticker.ts";

export const GOAL_CONTINUATION_SCHEDULED_EVENT = "goal_continuation_scheduled";
export const GOAL_CONTINUATION_RESUMED_EVENT = "goal_continuation_resumed";
export const GOAL_CONTINUATION_TIMER_STATE_EVENT = "goal_continuation_timer_state";
export const GOAL_MONITOR_STALL_EVENT = "goal_monitor_continuation_stall";

export class MonitorAwareGoalContinuation {
	readonly #pi: ExtensionAPI;
	readonly #isContinuationPending: () => boolean;
	readonly #markContinuationPending: () => void;
	readonly #waitTicker: GoalWaitTicker | undefined;
	#wakeSources = new Map<string, number>();
	#hasStarted = false;
	#ctx: ExtensionContext | undefined;
	#goal: Goal | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#scheduledContinuationKind: DelayedContinuationKind | undefined;
	#channelStateUnsubscribers: Array<() => void> = [];
	#lastAgentEndMessages: readonly AgentMessage[] = [];
	#consecutiveLengthRecoveries = new Map<string, number>();
	#recentNormalizedOutputHashes: string[] = [];
	#toollessContinuationStreak = 0;
	#toollessStreakGoalId: string | null = null;
	#endedTurnWasUserInitiated = false;
	#lastTurnUsage: TokenUsageSnapshot | undefined;
	#scheduledAtMs: number | undefined;
	#scheduledDueAtMs: number | undefined;
	#scheduledCache: GoalCacheWarmMetrics | undefined;
	#scheduledDelayMs: number | undefined;
	#cacheWarmIteration = 0;
	#scheduledCacheWarmIteration: number | undefined;
	#heldTimer:
		| { kind: DelayedContinuationKind; remainingMs: number; heldAtMs: number; totalMs: number; drainFire: boolean }
		| undefined;
	#directInputHolds = new Set<string>();
	#pendingSystemRecovery: SystemAbortOptions | undefined;

	constructor(
		pi: ExtensionAPI,
		isContinuationPending: () => boolean = () => false,
		markContinuationPending: () => void = () => {},
		waitTicker?: GoalWaitTicker,
	) {
		this.#pi = pi;
		this.#isContinuationPending = isContinuationPending;
		this.#markContinuationPending = markContinuationPending;
		this.#waitTicker = waitTicker;
		this.#subscribeToChannelState();
	}

	start(ctx: ExtensionContext): void {
		this.#cancelTimer();
		this.#ctx = ctx;
		if (this.#hasStarted) this.#wakeSources.clear();
		else this.#hasStarted = true;
		this.#goal = null;
		this.#lastAgentEndMessages = [];
		this.#directInputHolds.clear();
		this.#resetContinuationState();
	}

	async afterAgentEnd(options: AgentEndOptions): Promise<Goal | null> {
		if (options.goal?.id !== this.#goal?.id) this.#resetContinuationState();
		this.#ctx = options.ctx;
		this.#goal = options.goal;
		this.#lastAgentEndMessages = options.messages;
		this.#lastTurnUsage = collectAssistantUsage([...options.messages]);
		this.#resetLengthRecoveryAfterCleanStop(options.goal, options.messages);
		const turnUsedTools = continuationTurnUsedTools(options.messages);
		this.#recordAssistantOutput(options.messages, turnUsedTools);
		if (options.goal?.status !== "active") {
			this.#cancelTimer();
			this.#resetContinuationState();
			return options.goal;
		}
		this.#recordToollessContinuationTurn(options.goal, turnUsedTools);
		const immediateInput = this.#buildVerdictInput(options.ctx, options.goal, "immediate", options.messages);
		const goal =
			!this.#endedTurnWasUserInitiated && (turnUsedTools || hasGoalContinuationProgress(immediateInput))
				? ((await resetContinuationStreak(goalStoreRef(options.ctx.sessionManager, options.ctx.cwd))) ??
					options.goal)
				: options.goal;
		this.#goal = goal;
		const immediateVerdict = evaluateGoalContinuation({
			goal,
			...this.#buildVerdictInput(options.ctx, goal, "immediate", options.messages),
		});
		if (this.#endedTurnWasUserInitiated) {
			this.#endedTurnWasUserInitiated = false;
			this.#cancelTimer();
			if (immediateVerdict.kind === "continue") {
				this.#schedule(goal, "userGrace");
				return goal;
			}
			switch (immediateVerdict.reason) {
				case "not-eligible":
				case "single-flight":
				case "stale":
					return goal;
				case "cap":
				case "repetition":
				case "length-exhausted": {
					const admission = await this.#admitAndQueue(options.ctx, goal, "immediate", options.messages);
					return admission.goal;
				}
			}
		}
		if (immediateVerdict.kind === "deny" && immediateVerdict.reason === "not-eligible") return goal;

		if (this.#activeWakeSourceCount() === 0) {
			this.#cancelTimer();
			const admission = await this.#admitAndQueue(options.ctx, goal, "immediate", options.messages);
			return admission.goal;
		}
		this.#schedule(goal, "monitor");
		return goal;
	}

	async afterSystemAbort(options: SystemAbortOptions): Promise<Goal | null> {
		this.noteContinuationStarted();
		if (options.goal?.id !== this.#goal?.id) this.#resetContinuationState();
		this.#pendingSystemRecovery = undefined;
		this.#ctx = options.ctx;
		this.#goal = options.goal;
		this.#lastAgentEndMessages = options.messages;
		this.#lastTurnUsage = collectAssistantUsage([...options.messages]);
		if (options.goal?.status !== "active") {
			this.#resetContinuationState();
			return options.goal;
		}
		if (options.willRetry) return options.goal;
		if (this.#activeWakeSourceCount() > 0) this.#schedule(options.goal, "monitor");
		else if (lastAssistantMessage(options.messages)?.stopReason === "error") {
			this.#pendingSystemRecovery = options;
		}
		return options.goal;
	}

	async afterAgentSettled(): Promise<Goal | null | undefined> {
		const pending = this.#pendingSystemRecovery;
		this.#pendingSystemRecovery = undefined;
		if (pending === undefined || pending.goal === null || pending.event.abortSource === "user") return undefined;
		return (await this.#admitAndQueue(pending.ctx, pending.goal, "systemRecovery", pending.messages)).goal;
	}

	syncGoal(goal: Goal | null): void {
		if (goal?.id !== this.#goal?.id) this.#resetContinuationState();
		this.#goal = goal;
		if (goal?.status !== "active") {
			this.#cancelTimer();
			this.#resetContinuationState();
		}
	}

	/** Temporarily prevents a scheduled continuation from racing unresolved direct-input admission. */
	holdDirectInput(inputId: string): void {
		if (this.#directInputHolds.has(inputId)) return;
		this.#directInputHolds.add(inputId);
		if (
			this.#directInputHolds.size !== 1 ||
			this.#timer === undefined ||
			this.#scheduledContinuationKind === undefined
		) {
			return;
		}
		const heldAtMs = Date.now();
		this.#heldTimer = {
			kind: this.#scheduledContinuationKind,
			remainingMs: Math.max(0, (this.#scheduledDueAtMs ?? heldAtMs) - heldAtMs),
			heldAtMs,
			totalMs: this.#scheduledDelayMs ?? GOAL_USER_GRACE_DELAY_MS,
			drainFire: false,
		};
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#scheduledDueAtMs = undefined;
		this.#waitTicker?.stop();
	}

	/** Resolves one admission hold without allowing overlapping inputs to consume each other. */
	resolveDirectInput(inputId: string, accepted: boolean): void {
		if (!this.#directInputHolds.delete(inputId)) return;
		if (accepted) {
			this.#heldTimer = undefined;
			this.noteUserPrompt();
			return;
		}
		if (this.#directInputHolds.size > 0 || this.#heldTimer === undefined) return;
		const held = this.#heldTimer;
		this.#heldTimer = undefined;
		const elapsedWhileHeldMs = Math.max(0, Date.now() - held.heldAtMs);
		this.#armTimer(held.kind, Math.max(0, held.remainingMs - elapsedWhileHeldMs), held.totalMs, held.drainFire);
	}

	/** An accepted real user prompt starts a grace-governed user turn. */
	noteUserPrompt(): void {
		this.#cancelTimer();
		this.#endedTurnWasUserInitiated = true;
		this.#resetContinuationState();
	}

	/** A hidden continuation or system recovery has started, so the next end is not user-initiated. */
	noteContinuationStarted(): void {
		this.#endedTurnWasUserInitiated = false;
	}

	dispose(): void {
		this.#cancelTimer();
		for (const unsubscribe of this.#channelStateUnsubscribers) unsubscribe();
		this.#channelStateUnsubscribers = [];
		this.#ctx = undefined;
		this.#goal = null;
		this.#wakeSources.clear();
		this.#lastAgentEndMessages = [];
		this.#directInputHolds.clear();
		this.#resetContinuationState();
	}

	#schedule(goal: Goal, kind: DelayedContinuationKind): void {
		if (this.#scheduledContinuationKind !== undefined) return;
		const delayMs =
			kind === "monitor"
				? resolveGoalMonitorContinuationDelayMs(
						this.#ctx?.getPromptCacheSafeWaitSeconds?.(),
						this.#ctx?.getPromptCacheGoalBackstopMaxSeconds?.(),
					)
				: GOAL_USER_GRACE_DELAY_MS;
		this.#scheduledDelayMs = delayMs;
		if (kind === "monitor") {
			this.#cacheWarmIteration += 1;
			this.#scheduledCacheWarmIteration = this.#cacheWarmIteration;
			const iteration = this.#scheduledCacheWarmIteration;
			const cache = estimateCacheWarmMetrics(this.#ctx?.model, process.env, this.#lastTurnUsage);
			const wakeSources = this.#wakeSourceSnapshot();
			this.#scheduledCache = cache;
			this.#scheduledAtMs = Date.now();
			this.#pi.events?.emit(GOAL_CONTINUATION_SCHEDULED_EVENT, {
				goalId: goal.id,
				delayMs,
				iteration,
				activeMonitorCount: this.#activeWakeSourceCount(),
				wakeSources,
				cache,
			});
			this.#appendWarmupEntry({
				phase: "scheduled",
				goalId: goal.id,
				delayMs,
				iteration,
				activeMonitorCount: this.#activeWakeSourceCount(),
				wakeSources,
				...(cache !== undefined ? { cache } : {}),
			});
		} else {
			this.#scheduledAtMs = undefined;
			this.#scheduledCache = undefined;
			this.#scheduledCacheWarmIteration = undefined;
		}
		this.#scheduledContinuationKind = kind;
		this.#pi.events?.emit(GOAL_CONTINUATION_TIMER_STATE_EVENT, { armed: true, kind });
		if (this.#directInputHolds.size > 0) {
			this.#heldTimer = { kind, remainingMs: delayMs, heldAtMs: Date.now(), totalMs: delayMs, drainFire: false };
			return;
		}
		this.#armTimer(kind, delayMs, delayMs);
	}

	#armTimer(kind: DelayedContinuationKind, delayMs: number, totalMs: number, drainFire = false): void {
		this.#scheduledDueAtMs = Date.now() + delayMs;
		const ctx = this.#ctx;
		if (ctx?.hasUI) {
			this.#waitTicker?.sync(ctx, {
				kind,
				remainingMs: delayMs,
				totalMs,
				channelCounts: this.#wakeSourceSnapshot(),
			});
		}
		this.#timer = setTimeout(() => {
			void this.#continueIfEligible(kind, drainFire).catch((error: unknown) => {
				if (this.#ctx?.hasUI) {
					const message = error instanceof Error ? error.message : String(error);
					this.#ctx.ui.notify(`Goal continuation delivery failed: ${message}`, "error");
				}
			});
		}, delayMs);
	}

	async #continueIfEligible(kind: DelayedContinuationKind, drainFire = false): Promise<void> {
		this.#timer = undefined;
		this.#scheduledDueAtMs = undefined;
		this.#scheduledContinuationKind = undefined;
		this.#pi.events?.emit(GOAL_CONTINUATION_TIMER_STATE_EVENT, { armed: false, kind });
		this.#waitTicker?.stop();
		const delayMs =
			this.#scheduledDelayMs ??
			(kind === "monitor" ? GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS : GOAL_USER_GRACE_DELAY_MS);
		const waitedMs = this.#scheduledAtMs === undefined ? delayMs : Math.max(0, Date.now() - this.#scheduledAtMs);
		const cache = this.#scheduledCache;
		const iteration = this.#scheduledCacheWarmIteration;
		this.#scheduledAtMs = undefined;
		this.#scheduledCache = undefined;
		this.#scheduledDelayMs = undefined;
		this.#scheduledCacheWarmIteration = undefined;
		const ctx = this.#ctx;
		const goal = this.#goal;
		if (ctx === undefined || goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (kind === "monitor" && this.#activeWakeSourceCount() === 0 && !drainFire) return;
		const admission = await this.#admitAndQueue(
			ctx,
			goal,
			kind === "monitor" ? "monitorDelayed" : "userGrace",
			this.#lastAgentEndMessages,
		);
		if (kind !== "monitor" || !admission.admitted || iteration === undefined) return;
		const wakeSources = this.#wakeSourceSnapshot();
		this.#pi.events?.emit(GOAL_CONTINUATION_RESUMED_EVENT, {
			goalId: goal.id,
			delayMs,
			waitedMs,
			iteration,
			activeMonitorCount: this.#activeWakeSourceCount(),
			wakeSources,
			cache,
		});
		this.#appendWarmupEntry({
			phase: "resumed",
			goalId: goal.id,
			delayMs,
			waitedMs,
			iteration,
			activeMonitorCount: this.#activeWakeSourceCount(),
			wakeSources,
			...(cache !== undefined ? { cache } : {}),
		});
		if (drainFire || admission.goal.status !== "active") this.#resetCacheWarmIteration();
	}

	async #admitAndQueue(
		ctx: ExtensionContext,
		goal: Goal,
		path: GoalContinuationPath,
		messages: readonly AgentMessage[],
	): Promise<GoalContinuationAdmission> {
		const input = this.#buildVerdictInput(ctx, goal, path, messages);
		const verdict = evaluateGoalContinuation({ goal, ...input });
		const admittedGoal = await admitAndQueueGoalContinuation(this.#pi, ctx, goal, {
			input,
			content: (continuationVerdict) => this.#buildContinuationContent(ctx, goal, continuationVerdict),
			markContinuationPending: this.#markContinuationPending,
		});
		if (admittedGoal === null) {
			this.#goal = null;
			this.#cancelTimer();
			this.#resetToollessContinuationStreak();
			return { goal, admitted: false };
		}
		if (verdict.kind === "continue" && input.lastStopReason === "length") {
			this.#consecutiveLengthRecoveries.set(goal.id, input.consecutiveLengthRecoveries + 1);
		}
		this.#goal = admittedGoal;
		if (admittedGoal.status !== "active") {
			this.#cancelTimer();
			this.#resetToollessContinuationStreak();
		}
		return { goal: admittedGoal, admitted: verdict.kind === "continue" };
	}

	#appendWarmupEntry(data: LiveGoalCacheWarmupEntryData): void {
		this.#pi.appendEntry?.<GoalCacheWarmupEntryData>(GOAL_CACHE_WARMUP_ENTRY_TYPE, data);
	}

	#buildVerdictInput(
		ctx: ExtensionContext,
		goal: Goal,
		path: GoalContinuationPath,
		messages: readonly AgentMessage[],
	): Omit<GoalContinuationInput, "goal"> {
		const lastAssistant = lastAssistantMessage(messages);
		return {
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			path,
			lastStopReason: lastAssistant?.stopReason,
			consecutiveContinuations: goal.consecutiveContinuations ?? 0,
			lastContinuationSignature: goal.lastContinuationSignature,
			currentSignature: buildCurrentGoalContinuationSignature(ctx, goal, lastAssistantText(messages)),
			consecutiveLengthRecoveries: this.#consecutiveLengthRecoveries.get(goal.id) ?? 0,
			recentNormalizedOutputHashes: this.#recentNormalizedOutputHashes,
			toollessContinuationStreak: this.#toollessContinuationStreak,
			continuationPending: this.#isContinuationPending(),
		};
	}

	#buildContinuationContent(ctx: ExtensionContext, goal: Goal, verdict: ContinuingGoalContinuationVerdict): string {
		let content = verdict.prompt === "minimal" ? buildTruncationRecoveryPrompt() : buildContinuationPrompt(goal);
		if (!verdict.stallNotice) return content;

		const liveSources = this.#liveWakeSources();
		this.#pi.events?.emit(GOAL_MONITOR_STALL_EVENT, {
			goalId: goal.id,
			consecutiveContinuations: this.#toollessContinuationStreak,
			toolless: true,
		});
		if (ctx.hasUI) {
			const context =
				liveSources.length > 0 ? `while ${liveSources.join(", ")} channels stayed active` : "without tool use";
			ctx.ui.notify(
				`Goal continuation repeated ${this.#toollessContinuationStreak} toolless turns ${context} - injected a stall check.`,
				"info",
			);
		}
		content = `${buildGoalStallNotice(this.#toollessContinuationStreak, { liveSources })}\n\n${content}`;
		return content;
	}

	/** A tool-using turn is forward progress, so it clears the repetition window instead of extending it. */
	#recordAssistantOutput(messages: readonly AgentMessage[], turnUsedTools: boolean): void {
		if (turnUsedTools) {
			this.#recentNormalizedOutputHashes = [];
			return;
		}
		const text = lastAssistantText(messages);
		if (normalizeAssistantText(text).length === 0) return;
		this.#recentNormalizedOutputHashes = [...this.#recentNormalizedOutputHashes, hashAssistantText(text)].slice(-3);
	}

	#recordToollessContinuationTurn(goal: Goal, turnUsedTools: boolean): void {
		if (goal.id !== this.#toollessStreakGoalId) {
			this.#toollessStreakGoalId = goal.id;
			this.#toollessContinuationStreak = 0;
		}
		if (this.#endedTurnWasUserInitiated) return;
		if (turnUsedTools) {
			this.#toollessContinuationStreak = 0;
			return;
		}
		this.#toollessContinuationStreak += 1;
	}

	#resetLengthRecoveryAfterCleanStop(goal: Goal | null, messages: readonly AgentMessage[]): void {
		if (goal === null || lastAssistantMessage(messages)?.stopReason !== "stop") return;
		this.#consecutiveLengthRecoveries.delete(goal.id);
	}

	#subscribeToChannelState(): void {
		const events = this.#pi.events;
		if (events === undefined) return;
		this.#channelStateUnsubscribers.push(
			events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
				if (!isTerminalMonitorStateEvent(data)) return;
				this.#setWakeSourceCount("terminal-monitors", data.activeCount);
			}),
			events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
				if (!isWakeSourceStateEvent(data)) return;
				this.#setWakeSourceCount(data.source, data.activeCount);
			}),
		);
	}

	#setWakeSourceCount(source: string, activeCount: number): void {
		const previousTotal = this.#activeWakeSourceCount();
		this.#wakeSources.set(source, activeCount);
		const nextTotal = this.#activeWakeSourceCount();
		if (previousTotal > 0 && nextTotal === 0) {
			if (this.#scheduledContinuationKind === "monitor") this.#armDrainFire();
			else this.#resetCacheWarmIteration();
			this.#resetToollessContinuationStreak();
			return;
		}
		if (this.#scheduledContinuationKind === "monitor") {
			this.#waitTicker?.setChannelCounts(this.#wakeSourceSnapshot());
		}
	}

	#armDrainFire(): void {
		if (this.#directInputHolds.size > 0) {
			this.#heldTimer = {
				kind: "monitor",
				remainingMs: 1_000,
				heldAtMs: Date.now(),
				totalMs: 1_000,
				drainFire: true,
			};
			return;
		}
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#scheduledDueAtMs = undefined;
		this.#waitTicker?.stop();
		this.#armTimer("monitor", 1_000, 1_000, true);
	}

	#activeWakeSourceCount(): number {
		let total = 0;
		for (const count of this.#wakeSources.values()) total += count;
		return total;
	}

	#wakeSourceSnapshot(): ResumptionChannelCounts {
		return Object.fromEntries([...this.#wakeSources.entries()].sort(([left], [right]) => left.localeCompare(right)));
	}

	#liveWakeSources(): string[] {
		return [...this.#wakeSources.entries()]
			.filter(([, count]) => count > 0)
			.map(([source]) => source)
			.sort();
	}

	#resetContinuationState(): void {
		this.#pendingSystemRecovery = undefined;
		this.#consecutiveLengthRecoveries.clear();
		this.#recentNormalizedOutputHashes = [];
		this.#resetToollessContinuationStreak();
		this.#resetCacheWarmIteration();
	}

	#resetCacheWarmIteration(): void {
		this.#cacheWarmIteration = 0;
		this.#scheduledCacheWarmIteration = undefined;
	}

	#resetToollessContinuationStreak(): void {
		this.#toollessContinuationStreak = 0;
		this.#toollessStreakGoalId = null;
	}

	#cancelTimer(): void {
		const kind = this.#scheduledContinuationKind;
		this.#scheduledAtMs = undefined;
		this.#scheduledDueAtMs = undefined;
		this.#scheduledCache = undefined;
		this.#scheduledDelayMs = undefined;
		this.#scheduledCacheWarmIteration = undefined;
		this.#heldTimer = undefined;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#scheduledContinuationKind = undefined;
		if (kind !== undefined) this.#pi.events?.emit(GOAL_CONTINUATION_TIMER_STATE_EVENT, { armed: false, kind });
		this.#waitTicker?.stop();
	}
}
