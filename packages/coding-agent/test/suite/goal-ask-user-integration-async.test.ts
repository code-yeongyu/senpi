/**
 * Todo 26, scenarios (b), (c) and (d): an ASYNC question returns immediately and
 * parks the goal on the question's own deadline instead of the 270s backstop, so
 * the model is woken exactly once - by the framed user message the ask-user
 * extension delivers on the answer or the idle timeout, never by a continuation
 * stacked on top of it - and the goal stays active throughout.
 */

import { afterEach, describe, expect, it } from "vitest";
import { GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS } from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import { GOAL_CONTINUATION_SCHEDULED_EVENT } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { waitForSentCount } from "./goal-monitor-test-harness.ts";
import {
	createGoalAskUserWorld,
	GOAL_CONTINUATION_MESSAGE_TYPE,
	GOAL_GUARD_TRIPPED_EVENT,
	type GoalAskUserWorld,
	QUESTION_TIMEOUT_MS,
	TIMEOUT_MARKER,
} from "./helpers/goal-ask-user.ts";

const TEN_MINUTES_MS = 600_000;

let world: GoalAskUserWorld | undefined;

afterEach(async () => {
	await world?.cleanup();
	world = undefined;
});

describe("goal loop with an async ask-user question", () => {
	it("sends no continuation before the deadline and wakes once on the timeout", async () => {
		world = await createGoalAskUserWorld("thread-ask-user-async-timeout");
		await world.startTurn();
		const accepted = await world.askAsync("call-async-timeout");
		expect(accepted.details).toMatchObject({ accepted: true, status: "pending" });
		expect(world.questionCalls).toEqual([expect.objectContaining({ deliver: "user-message" })]);
		await world.endTurn();

		// The periodic backstop is parked on the question deadline (todo 12).
		expect(world.eventsOn(GOAL_CONTINUATION_SCHEDULED_EVENT)[0]).toMatchObject({
			delayMs: QUESTION_TIMEOUT_MS,
			wakeSources: { "ask-user": 1 },
		});
		await world.advance(QUESTION_TIMEOUT_MS - 1);
		expect(world.goal.sent).toHaveLength(0);
		expect(world.ask.deliveries).toHaveLength(0);

		await world.advance(1);
		await expect(world.settleQuestion()).resolves.toMatchObject({ status: "timed_out" });
		expect(world.ask.deliveries).toHaveLength(1);
		expect(String(world.ask.deliveries[0]?.content)).toContain(TIMEOUT_MARKER);
		expect(String(world.ask.deliveries[0]?.content)).toContain("[Answer to question call-async-timeout]");
		expect(world.ask.deliveries[0]?.options).toEqual({ deliverAs: "followUp" });

		// That follow-up is the single wake: the drained wake source must not stack
		// a continuation prompt on top of it.
		await world.advance(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS * 2);
		expect(world.goal.sent).toHaveLength(0);
		expect(world.ask.deliveries).toHaveLength(1);

		// The woken turn ends: the goal resumes on the normal path, still active.
		await world.startTurn();
		const delivered = waitForSentCount(world.goal, 1);
		await world.endTurn();
		await delivered;
		expect(world.goal.sent).toHaveLength(1);
		expect(world.goal.sent[0]?.message.customType).toBe(GOAL_CONTINUATION_MESSAGE_TYPE);
		expect(await world.currentGoal()).toMatchObject({ status: "active" });
		expect(world.eventsOn(GOAL_GUARD_TRIPPED_EVENT)).toHaveLength(0);
	});

	it("delivers an answer given at ten minutes exactly once, with no duplicate continuation", async () => {
		world = await createGoalAskUserWorld("thread-ask-user-async-answered");
		await world.startTurn();
		await world.askAsync("call-async-answered");
		await world.endTurn();

		await world.advance(TEN_MINUTES_MS);
		expect(world.goal.sent).toHaveLength(0);
		expect(world.ask.deliveries).toHaveLength(0);

		await world.answer("OAuth");
		expect(world.ask.deliveries).toEqual([
			{
				content: "[Answer to question call-async-answered]\nLibrary: OAuth",
				options: { deliverAs: "followUp" },
			},
		]);

		// Past the original deadline: the parked timer was replaced by the drain
		// fire, and the drain fire yields to the answer that is already queued.
		await world.advance(QUESTION_TIMEOUT_MS);
		expect(world.ask.deliveries).toHaveLength(1);
		expect(world.goal.sent).toHaveLength(0);

		await world.startTurn();
		const delivered = waitForSentCount(world.goal, 1);
		await world.endTurn();
		await delivered;
		expect(world.goal.sent).toHaveLength(1);
		expect(await world.currentGoal()).toMatchObject({ status: "active" });
		expect(world.eventsOn(GOAL_GUARD_TRIPPED_EVENT)).toHaveLength(0);
	});
});
