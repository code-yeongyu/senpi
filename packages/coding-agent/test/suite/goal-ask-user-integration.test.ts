/**
 * Todo 26, scenarios (a) and (d): a BLOCKING question parks the model inside the
 * tool call, so the goal loop must stay completely silent for the whole wait -
 * no continuation, no wake source, no second copy of the answer - and the turn
 * that ends after the answer must take the normal continuation path with the
 * goal still active (nothing may flip it to `blocked`).
 *
 * The async half lives in goal-ask-user-integration-async.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { GOAL_CONTINUATION_SCHEDULED_EVENT } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { waitForSentCount } from "./goal-monitor-test-harness.ts";
import {
	createGoalAskUserWorld,
	GOAL_CONTINUATION_MESSAGE_TYPE,
	GOAL_GUARD_TRIPPED_EVENT,
	type GoalAskUserWorld,
} from "./helpers/goal-ask-user.ts";

const FORTY_MINUTES_MS = 2_400_000;
/** Longer than the wait under test so the question is still open at 40 minutes. */
const BLOCKING_TIMEOUT_MINUTES = 60;

let world: GoalAskUserWorld | undefined;

afterEach(async () => {
	await world?.cleanup();
	world = undefined;
});

describe("goal loop with a blocking ask-user question", () => {
	it("queues no continuation for 40 minutes and resumes the normal path on the answer", async () => {
		world = await createGoalAskUserWorld("thread-ask-user-blocking", BLOCKING_TIMEOUT_MINUTES);
		await world.startTurn();
		const toolResult = world.askBlocking("call-blocking");
		await world.advance(FORTY_MINUTES_MS);

		expect(world.goal.sent).toHaveLength(0);
		expect(world.eventsOn(GOAL_CONTINUATION_SCHEDULED_EVENT)).toHaveLength(0);
		// A blocking question is answered through the tool result, so it registers
		// no wake source and the extension must not deliver a user message for it.
		expect(world.ask.wakeEvents).toHaveLength(0);
		expect(world.ask.deliveries).toHaveLength(0);
		expect(world.questionCalls).toEqual([expect.objectContaining({ deliver: "tool-result" })]);

		await world.answer("OAuth");
		expect(await toolResult).toMatchObject({ content: [{ type: "text", text: "Library: OAuth" }] });
		expect(world.ask.deliveries).toHaveLength(0);

		const delivered = waitForSentCount(world.goal, 1);
		await world.endTurn();
		await delivered;

		expect(world.goal.sent).toHaveLength(1);
		expect(world.goal.sent[0]?.message.customType).toBe(GOAL_CONTINUATION_MESSAGE_TYPE);
	});

	it("never blocks the goal while the user is deciding", async () => {
		world = await createGoalAskUserWorld("thread-ask-user-blocking-guard", BLOCKING_TIMEOUT_MINUTES);
		await world.startTurn();
		const toolResult = world.askBlocking("call-blocking-guard");
		await world.advance(FORTY_MINUTES_MS);
		await world.answer("OAuth");
		await toolResult;

		const delivered = waitForSentCount(world.goal, 1);
		await world.endTurn();
		await delivered;

		// (d) no `update_goal(blocked)`: the store never leaves `active` and no
		// continuation guard (cap/unattended/repetition) tripped on the long wait.
		expect(await world.currentGoal()).toMatchObject({ status: "active" });
		expect(world.eventsOn(GOAL_GUARD_TRIPPED_EVENT)).toHaveLength(0);
		expect(world.notices.filter((notice) => notice.toLowerCase().includes("blocked"))).toHaveLength(0);
	});
});
