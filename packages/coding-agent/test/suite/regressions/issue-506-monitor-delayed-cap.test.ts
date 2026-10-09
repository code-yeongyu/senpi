import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitAndQueueGoalContinuation } from "../../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import {
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	type AppendedGoalEntry,
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createSentMessageHarness,
	makeGoalContext,
	TestEventBus,
	waitForEventCount,
	waitForSentCount,
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

	// senpi#3007: additive stop entries must not suppress the existing shared-cap guard event.
	it.each(["available", "missing", "throws-after-append"] as const)(
		"persists a delayed delivery and blocks the next one at the shared cap (%s entry writer)",
		async (entryWriter) => {
			vi.useFakeTimers();
			const notices: string[] = [];
			const ctx = await makeGoalContext(notices, "issue-506-monitor-delayed-cap");
			const harness = createSentMessageHarness();
			const events = new TestEventBus();
			const entries: AppendedGoalEntry[] = [];
			const pi = {
				sendMessage: harness.sendMessage,
				events,
				...(entryWriter === "missing"
					? {}
					: {
							appendEntry: (customType: string, data: unknown) => {
								entries.push({ customType, data });
								if (customType === "goal-continuation-stopped" && entryWriter === "throws-after-append") {
									throw new Error("Entry publication failed");
								}
							},
						}),
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
			const delayedDeliveryRecorded = waitForSentCount(harness, 1);
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
			await delayedDeliveryRecorded;

			expect(harness.sent).toHaveLength(1);
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
			const guardTripped = waitForEventCount(events, "goal_continuation_guard_tripped", 1);
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
			await guardTripped;

			expect(harness.sent).toHaveLength(1);
			expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
				status: "blocked",
				blockedReason: "continuation cap reached",
			});
			expect(events.emitted.filter((event) => event.channel === "goal_continuation_guard_tripped")).toEqual([
				{
					channel: "goal_continuation_guard_tripped",
					data: { goalId: goal.id, reason: "cap", count: 8, unattendedContinuations: 0 },
				},
			]);
			expect(entries.filter((entry) => entry.customType === "goal-continuation-stopped")).toEqual(
				entryWriter === "missing"
					? []
					: [
							{
								customType: "goal-continuation-stopped",
								data: {
									goalId: goal.id,
									reason: "cap",
									consecutiveContinuations: 8,
									unattendedContinuations: 0,
									at: Date.now(),
								},
							},
						],
			);
			monitor.dispose();
		},
	);

	it("cancels when delivery accounting no longer has a current goal", async () => {
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
						lastTurnWasMalformedToolUse: false,
						consecutiveContinuations: 7,
						lastContinuationSignature: undefined,
						currentSignature: `${goal.id}:0/0:deadbeef`,
						consecutiveLengthRecoveries: 0,
						lastTurnStuckOnContextOverflow: false,
						recentNormalizedOutputHashes: [],
						toollessContinuationStreak: 0,
						continuationPending: false,
					},
					content: () => "Continue",
					markContinuationPending: () => {},
				},
			),
		).resolves.toBeNull();
		expect(queued).toBe(false);
	});
});
