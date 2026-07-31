import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitAndQueueGoalContinuation } from "../../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import {
	GOAL_MONITOR_CONTINUATION_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	makeGoalContext,
	TestEventBus,
	waitForGoalContinuationCount,
} from "../goal-monitor-test-harness.ts";

function goalStoreRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function activeGoal(id: string): Goal {
	return {
		id,
		threadId: `${id}-thread`,
		objective: "Keep monitoring",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		consecutiveContinuations: 7,
	};
}

function assistantStopWithText(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected an assistant stop message");
	return { ...message, content: [{ type: "text", text }] };
}

describe("issue #506: monitor-delayed continuation cap", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("persists a delayed delivery and blocks the next one at the shared cap", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-506-monitor-delayed-cap");
		const sent: string[] = [];
		const events = new TestEventBus();
		const pi = {
			sendMessage: (message: { readonly content: string }) => sent.push(message.content),
			events,
		} as unknown as ExtensionAPI;
		const monitor = new MonitorAwareGoalContinuation(pi);
		const goal = activeGoal("goal-issue-506");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();

		await monitor.afterAgentEnd({
			ctx,
			goal,
			messages: [assistantStopWithText("still waiting")],
		});
		const delayedDeliveryRecorded = waitForGoalContinuationCount(ctx, 8);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		await delayedDeliveryRecorded;

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			consecutiveContinuations: 8,
		});

		const countedGoal = await readGoal(goalStoreRef(ctx));
		if (countedGoal === null) throw new Error("Expected persisted goal");
		await monitor.afterAgentEnd({
			ctx,
			goal: countedGoal,
			messages: [assistantStopWithText("still waiting")],
		});
		const blockedGoalRecorded = waitForGoalContinuationCount(ctx, 0);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		await blockedGoalRecorded;

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "continuation cap reached",
		});
	});

	it("fails closed when delivery accounting cannot be persisted", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-506-persistence-failure");
		const goal = activeGoal("goal-issue-506-missing-store");
		let queued = false;

		await expect(
			admitAndQueueGoalContinuation(
				{
					sendMessage: () => {
						queued = true;
					},
				} as unknown as ExtensionAPI,
				ctx,
				goal,
				{
					input: {
						isIdle: true,
						hasPendingMessages: false,
						path: "monitorDelayed",
						lastStopReason: "stop",
						consecutiveContinuations: 7,
						lastContinuationSignature: undefined,
						currentSignature: `${goal.id}:0/0:deadbeef`,
						consecutiveLengthRecoveries: 0,
						recentNormalizedOutputHashes: [],
						toollessContinuationStreak: 0,
						continuationPending: false,
					},
					content: () => "Continue",
					markContinuationPending: () => {},
				},
			),
		).rejects.toThrow("Cannot persist goal continuation delivery");
		expect(queued).toBe(false);
	});
});
