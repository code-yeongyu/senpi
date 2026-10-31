import { createSessionLogger } from "../../../session-log.ts";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "../../types.ts";
import { lastAssistantText } from "./lifecycle-helpers.ts";
import type { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import { providerRetryAt } from "./provider-retry.ts";
import { publishGoalContinuationEvent } from "./rpc-wait-surface.ts";
import { openTodoTaskContents } from "./todo-gate.ts";
import { calledAskUser, endsWithQuestion, type TodoOwedOutcome } from "./todo-owed-backstop.ts";
import {
	classifyTurnEnd,
	evaluateTurnEndLiveness,
	type OpenWork,
	repeatsLastStall,
	TURN_END_LIVENESS_ENTRY_TYPE,
	TURN_END_LIVENESS_EVENT,
	type TurnEndLivenessInput,
	type WakeExpectation,
} from "./turn-end-liveness.ts";
import type { Goal } from "./types.ts";

/** What the goal extension knows at a turn end after its two lanes ran. */
export interface TurnEndLivenessState {
	readonly goal: Goal | null;
	readonly todoOutcome: TodoOwedOutcome | undefined;
	readonly deadlineStop: boolean;
	readonly continuationPending: boolean;
	readonly monitor: Pick<
		MonitorAwareGoalContinuation,
		"liveWakeSources" | "scheduledContinuation" | "hasStagedRecovery"
	>;
}

/** A person's input is among the entries queued now (tagged by source when it was enqueued). */
function personInputQueued(ctx: ExtensionContext): boolean {
	return ctx.hasQueuedPersonInput?.() === true;
}

/** senpi#3860's hold ledger, when the engine exposes it: true while every engine-originated wake is held. */
function engineTurnsHeld(ctx: ExtensionContext): boolean {
	if (!("engineTurnsHeld" in ctx)) return false;
	const probe = ctx.engineTurnsHeld;
	return typeof probe === "function" && probe.call(ctx) === true;
}

/** Builds the decision input from session state; shared with lifecycle consumers so there is one collector. */
export function collectTurnEndLivenessInput(
	ctx: ExtensionContext,
	event: AgentEndEvent,
	state: TurnEndLivenessState,
): TurnEndLivenessInput {
	const { goal, todoOutcome, monitor } = state;
	const openTodos = openTodoTaskContents(ctx.sessionManager.getBranch()).length;
	const openWork: OpenWork =
		goal?.status === "active"
			? { kind: "active-goal", goalId: goal.id }
			: openTodos > 0
				? { kind: "open-todos", count: openTodos }
				: { kind: "none" };
	const expectations: WakeExpectation[] = monitor.liveWakeSources().map((source) => ({ kind: "wake-source", source }));
	const timer = monitor.scheduledContinuation();
	if (timer !== undefined) expectations.push({ kind: "armed-timer", timer });
	if (monitor.hasStagedRecovery()) expectations.push({ kind: "recovery-staged" });
	if (ctx.hasPendingMessages()) {
		expectations.push(personInputQueued(ctx) ? { kind: "user-input-queued" } : { kind: "pending-messages" });
	}
	if (calledAskUser(event.messages) || endsWithQuestion(lastAssistantText(event.messages))) {
		expectations.push({ kind: "question-to-user" });
	}
	return {
		isChildSession: ctx.sessionManager.getHeader?.()?.parentSession !== undefined,
		mode: ctx.mode,
		ledgerHold: engineTurnsHeld(ctx) ? "unattended" : undefined,
		endedBy: classifyTurnEnd(event),
		willRetry: event.willRetry === true,
		deadlineStop: state.deadlineStop,
		goalStopped: goal?.status === "paused" || goal?.status === "blocked",
		openWork,
		continuationQueued: state.continuationPending
			? "goal"
			: todoOutcome === "delivered"
				? "todo-backstop"
				: undefined,
		expectations,
		budgetSpent:
			(goal?.status === "active" && goal.continuationStoppedAt !== undefined) ||
			todoOutcome === "capped" ||
			todoOutcome === "cap",
		providerRetryAtMs: providerRetryAt(event.messages, Date.now()),
	};
}

/** Publishes the turn-end verdict and records a stall once; a refused write is logged, never thrown. */
export function reportTurnEndLiveness(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: AgentEndEvent,
	state: TurnEndLivenessState,
): void {
	const input = collectTurnEndLivenessInput(ctx, event, state);
	const verdict = evaluateTurnEndLiveness(input);
	publishGoalContinuationEvent(pi, TURN_END_LIVENESS_EVENT, { sessionId: ctx.sessionManager.getSessionId(), verdict });
	if (verdict.kind !== "stalled" || repeatsLastStall(ctx.sessionManager.getBranch(), verdict)) return;
	const logger = createSessionLogger(ctx.agentDir);
	try {
		pi.appendEntry(TURN_END_LIVENESS_ENTRY_TYPE, { verdict, openWork: input.openWork });
	} catch (error) {
		logger.warn("goal_continuation_record_write_failed", {
			kind: TURN_END_LIVENESS_ENTRY_TYPE,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
