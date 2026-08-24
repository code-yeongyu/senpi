import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_CONTINUATION_TIMER_STATE_EVENT } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { writeGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	createGoalStatusHarness,
	type GoalStatusUpdate,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "./goal-monitor-test-harness.ts";

function activeGoal(id: string): Goal {
	return {
		id,
		threadId: `${id}-thread`,
		objective: "Keep moving",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

async function persistGoal(ctx: ExtensionContext, goal: Goal): Promise<void> {
	await writeGoal(
		{
			baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
			threadId: ctx.sessionManager.getSessionId(),
		},
		goal,
	);
}

function waitUpdates(status: ReturnType<typeof createGoalStatusHarness>): GoalStatusUpdate[] {
	return status.updates.filter((update) => update.key === "goal-wait");
}

function timerStates(harness: ReturnType<typeof createGoalHarness>): Array<{ armed: boolean; kind?: string }> {
	return harness.events.emitted
		.filter((event) => event.channel === GOAL_CONTINUATION_TIMER_STATE_EVENT)
		.map((event) => event.data as { armed: boolean; kind?: string });
}

describe("goal wait countdown versus externally started turns", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("hides the countdown while a turn runs and restores it when the session parks again", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const status = createGoalStatusHarness();
		const ctx = await makeGoalContext(notices, "thread-foreign-turn", { pendingMessages: false, status });
		let turnActive = false;
		ctx.isIdle = () => !turnActive;
		const harness = createGoalHarness();
		const goal = activeGoal("goal-foreign-turn");
		await persistGoal(ctx, goal);

		harness.events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 1 });
		await harness.events.flush();
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);

		expect(waitUpdates(status).at(-1)?.text).toContain("goal continues in");
		expect(timerStates(harness).at(-1)).toMatchObject({ armed: true, kind: "monitor" });

		turnActive = true;
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(waitUpdates(status).at(-1)?.text).toBeUndefined();
		expect(timerStates(harness).at(-1)).toMatchObject({ armed: true, kind: "monitor" });

		turnActive = false;
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(waitUpdates(status).at(-1)?.text).toContain("goal continues in");
		expect(timerStates(harness).filter((state) => state.armed)).toHaveLength(1);

		const delivered = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(300_000);
		await delivered;
		expect(harness.sent).toHaveLength(1);
	});
});
