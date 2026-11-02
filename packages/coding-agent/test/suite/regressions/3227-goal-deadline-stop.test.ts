// senpi#3227 regression: a turn the deadline lease stopped is never auto-continued by the
// goal engine, even with an active goal and a live wake source; admitted user input
// releases the hold. A system abort without a deadline keeps today's monitor wait.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import { TURN_DEADLINE_ENTRY_TYPE } from "../../../src/core/turn-deadline.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

const SCHEDULED = "goal_continuation_scheduled";

type BranchEntry = { type: string; customType?: string; data?: unknown; message?: { role: string } };

const userEntry: BranchEntry = { type: "message", message: { role: "user" } };
const abortedAssistantEntry: BranchEntry = { type: "message", message: { role: "assistant" } };
const deadlineEntry: BranchEntry = {
	type: "custom",
	customType: TURN_DEADLINE_ENTRY_TYPE,
	data: { kind: "inactivity", limitMs: 120_000, elapsedMs: 120_000, at: 0 },
};

async function activeGoalWithWakeSource(threadId: string): Promise<{
	harness: GoalHarness;
	ctx: ExtensionContext;
	branch: BranchEntry[];
}> {
	const harness = createGoalHarness();
	const ctx = await makeGoalContext([], threadId);
	const branch: BranchEntry[] = [];
	(ctx.sessionManager as unknown as { getBranch: () => BranchEntry[] }).getBranch = () => branch;
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep working" }, undefined, undefined, ctx as ExtensionToolContext);
	harness.events.emit("wake_source_state", { source: "test-wake", activeCount: 1 });
	await harness.events.flush();
	return { harness, ctx, branch };
}

async function endSystemAbortedTurn(harness: GoalHarness, ctx: ExtensionContext, deadline?: object): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(
		harness.handlers,
		"agent_end",
		{
			type: "agent_end",
			aborted: true,
			abortSource: "system",
			willRetry: false,
			...(deadline === undefined ? {} : { deadline }),
			messages: [{ ...cleanAssistantStop(), stopReason: "aborted" as const }],
		},
		ctx,
	);
}

function scheduledCount(harness: GoalHarness): number {
	return harness.events.emitted.filter((event) => event.channel === SCHEDULED).length;
}

describe("goal engine after a turn deadline stop (senpi#3227)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("sends zero continuations for 10 minutes after a deadline stop, keeps the goal active, and resumes on user input", async () => {
		vi.useFakeTimers();
		const { harness, ctx, branch } = await activeGoalWithWakeSource("thread-deadline-hold");

		// Given a turn the lease stopped: the stop entry precedes the aborted assistant message
		branch.push(userEntry, deadlineEntry, abortedAssistantEntry);
		await endSystemAbortedTurn(harness, ctx, { kind: "inactivity", limitMs: 120_000, elapsedMs: 120_000 });

		// Then nothing is scheduled or sent over the next 10 minutes, and the goal stays active
		expect(scheduledCount(harness)).toBe(0);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(harness.sent).toHaveLength(0);
		expect(scheduledCount(harness)).toBe(0);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });

		// When the user sends a message, the hold releases and the goal loop waits on its wake source again
		branch.push(userEntry);
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", willRetry: false, messages: [cleanAssistantStop()] },
			ctx,
		);
		expect(scheduledCount(harness)).toBe(1);
	});

	it("keeps the monitor wait for a system abort that carries no deadline", async () => {
		vi.useFakeTimers();
		const { harness, ctx, branch } = await activeGoalWithWakeSource("thread-no-deadline");

		branch.push(userEntry, abortedAssistantEntry);
		await endSystemAbortedTurn(harness, ctx);

		expect(scheduledCount(harness)).toBe(1);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
	});
});
