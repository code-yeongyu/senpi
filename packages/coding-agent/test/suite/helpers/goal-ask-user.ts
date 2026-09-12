/**
 * Integration world for the ask-user <-> goal-loop regression (plan todo 26).
 *
 * The REAL ask-user builtin runs on a live session (t10b's delivery harness, so
 * every framed user message is recorded instead of starting a turn) and the REAL
 * goal extension runs on the fake-timer harness (t12's goal harness). They are
 * joined by the single channel they share in production: the `wake_source_state`
 * event the ask-user extension publishes while an async question is pending.
 *
 * The two contexts stay separate on purpose - the goal store needs a real
 * session directory, which the in-memory session manager of the ask-user
 * harness does not have - but both sides run their production code paths.
 */

import { join } from "node:path";
import { vi } from "vitest";
import type { QuestionDialogOptions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type {
	AgentToolResult,
	QuestionRequest,
	QuestionResponse,
	ToolDefinition,
} from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";
import { ASYNC_QUESTIONS, type AskUserDelivery, createAskUserDelivery } from "./ask-user-delivery.ts";

/** Literal the owner requires inside the idle-timeout notice. */
export const TIMEOUT_MARKER = "(사용자가 답변을 안하고 timeout 으로 종료됨)";
/** `askUser.timeoutMinutes` default (30) as ms: the idle deadline of a pending question. */
export const QUESTION_TIMEOUT_MS = 1_800_000;
export const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";
export const GOAL_GUARD_TRIPPED_EVENT = "goal_continuation_guard_tripped";
/** `toCanonical` assigns the Claude variant's single question this id. */
const QUESTION_ID = "q1";

type ToolResult = AgentToolResult<unknown>;
export type QuestionCall = { readonly request: QuestionRequest; readonly deliver: unknown };

export interface GoalAskUserWorld {
	readonly goal: GoalHarness;
	readonly ask: AskUserDelivery;
	/** Notices the goal extension pushed to the UI. */
	readonly notices: string[];
	/** Every question the stub surface received, with the delivery mode the tool requested. */
	readonly questionCalls: readonly QuestionCall[];
	/** Async question: resolves as soon as the tool accepted it. */
	askAsync(requestId: string): Promise<ToolResult>;
	/** Blocking question: the returned promise stays pending until `answer()`. */
	askBlocking(requestId: string): Promise<ToolResult>;
	/** Answers the open question on the stub surface and waits for the extension to settle it. */
	answer(label: string): Promise<void>;
	/** Awaits the settlement of the async question (used after advancing onto its deadline). */
	settleQuestion(): Promise<QuestionResponse>;
	advance(ms: number): Promise<void>;
	startTurn(): Promise<void>;
	endTurn(): Promise<void>;
	currentGoal(): Promise<Goal | null>;
	eventsOn(channel: string): unknown[];
	cleanup(): Promise<void>;
}

/**
 * Builds the world and installs fake timers (after the live session is up, so
 * session start-up never waits on a frozen clock). The goal is created and
 * active; the caller opens the first turn with `startTurn()`.
 */
export async function createGoalAskUserWorld(threadId: string, timeoutMinutes = 30): Promise<GoalAskUserWorld> {
	const ask = await createAskUserDelivery(timeoutMinutes);
	vi.useFakeTimers();
	const goal = createGoalHarness();
	const notices: string[] = [];
	const state = { pendingMessages: false };
	const ctx = await makeGoalContext(notices, threadId, state);
	const questionCalls: QuestionCall[] = [];
	let resolveQuestion: ((response: QuestionResponse) => void) | undefined;
	const askCtx = ask.context((request: QuestionRequest, opts?: QuestionDialogOptions) => {
		questionCalls.push({ request, deliver: opts?.deliver });
		return new Promise<QuestionResponse>((resolve) => {
			resolveQuestion = resolve;
		});
	});
	const unsubscribe = ask.harness.getExtensionRunner().onBusEvent(WAKE_SOURCE_STATE_EVENT, (data) => {
		goal.events.emit(WAKE_SOURCE_STATE_EVENT, data);
	});

	let consumedDeliveries = 0;
	let settledQuestion: Promise<QuestionResponse> | undefined;
	const syncPendingMessages = (): void => {
		// `pi.sendUserMessage` always triggers a turn (agent-session.ts:7173), so a
		// delivered answer leaves a queued user message until that turn starts. The
		// goal monitor has to see it, or its drain fire double-wakes the model.
		if (ask.deliveries.length > consumedDeliveries) state.pendingMessages = true;
	};
	const advance = async (ms: number): Promise<void> => {
		await vi.advanceTimersByTimeAsync(ms);
		await goal.events.flush();
		syncPendingMessages();
	};
	const goalTool = (name: string): ToolDefinition => {
		const definition = goal.tools.get(name);
		if (!definition) throw new Error(`the goal extension registered no ${name} tool`);
		return definition;
	};
	const execute = (requestId: string, waitForAnswer: boolean): Promise<ToolResult> =>
		ask.tool.execute(requestId, { questions: ASYNC_QUESTIONS, waitForAnswer }, undefined, undefined, askCtx);

	await runGoalHandlers(goal.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	await goalTool("create_goal").execute("create-goal", { objective: "Keep moving" }, undefined, undefined, ctx);

	return {
		goal,
		ask,
		notices,
		questionCalls,
		askAsync: async (requestId) => {
			const accepted = await execute(requestId, false);
			settledQuestion = ask.settled(askCtx, requestId);
			return accepted;
		},
		askBlocking: (requestId) => execute(requestId, true),
		answer: async (label) => {
			if (!resolveQuestion) throw new Error("the stub question surface has no open question");
			const resolve = resolveQuestion;
			resolveQuestion = undefined;
			resolve({ status: "answered", answers: { [QUESTION_ID]: { selected: [label] } }, unanswered: [] });
			if (settledQuestion) await settledQuestion;
			await advance(0);
		},
		settleQuestion: async () => {
			if (!settledQuestion) throw new Error("no async question is pending");
			const response = await settledQuestion;
			await advance(0);
			return response;
		},
		advance,
		startTurn: async () => {
			consumedDeliveries = ask.deliveries.length;
			state.pendingMessages = false;
			await runGoalHandlers(goal.handlers, "agent_start", { type: "agent_start" }, ctx);
		},
		endTurn: async () => {
			const event = { type: "agent_end", messages: [cleanAssistantStop()] };
			await runGoalHandlers(goal.handlers, "agent_end", event, ctx);
			await goal.events.flush();
			syncPendingMessages();
		},
		currentGoal: () =>
			readGoal({
				baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
				threadId: ctx.sessionManager.getSessionId(),
			}),
		eventsOn: (channel) =>
			goal.events.emitted.filter((event) => event.channel === channel).map((event) => event.data),
		cleanup: async () => {
			unsubscribe();
			ask.harness.cleanup();
			vi.useRealTimers();
			await cleanupGoalMonitorTempDirs();
		},
	};
}
