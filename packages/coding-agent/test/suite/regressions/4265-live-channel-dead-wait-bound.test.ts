import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS } from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { MonitorAwareGoalContinuation } from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { GoalWaitTicker } from "../../../src/core/extensions/builtin/goal/wait-ticker.ts";
import { cleanAssistantStop, cleanupGoalMonitorTempDirs, createSentMessageHarness, makeGoalContext, TestEventBus, waitForSentCount } from "../goal-monitor-test-harness.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

function activeGoal(id: string): Goal {
	return { id, threadId: `${id}-thread`, objective: "Keep moving", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 };
}

describe("goal live channel dead-wait bound (senpi#4265)", () => {
	afterEach(async () => { vi.useRealTimers(); await cleanupGoalMonitorTempDirs(); });
	it("a permanently live channel still surfaces a stall check after the higher bound", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-dead-bound");
		const messages = createSentMessageHarness();
		const events = new TestEventBus();
		const ticker = new GoalWaitTicker({ render: (c: any, t: string) => c.ui.setStatus("goal-wait", t) });
		const pi = { sendMessage: messages.sendMessage, events, appendEntry: () => {} } as unknown as ExtensionAPI;
		const monitor = new MonitorAwareGoalContinuation(pi, () => false, () => {}, ticker);
		const goal = activeGoal("goal-dead-bound");
		await writeGoal({ baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"), threadId: ctx.sessionManager.getSessionId() }, goal);
		monitor.start(ctx);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });
		await events.flush();

		const endTurnWithText = async (text: string) => {
			const m = cleanAssistantStop();
			if (m.role !== "assistant") throw new Error("x");
			await monitor.afterAgentEnd({ ctx, goal, messages: [{ ...m, content: [{ type: "text", text }] }] });
		};

		for (let i = 0; i < 4; i++) {
			await endTurnWithText(`waiting turn ${i}`);
			const next = waitForSentCount(messages, messages.sent.length + 1);
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
			await next;
		}
		const all = messages.sent.map((s: any) => s.message.content);
		expect(all.some((c: string) => c.includes("<goal_stall_check>"))).toBe(true);
	});

	it("a healthy channel that never stalls at the ordinary 3-turn bound", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-live-3");
		const messages = createSentMessageHarness();
		const events = new TestEventBus();
		const ticker = new GoalWaitTicker({ render: (c: any, t: string) => c.ui.setStatus("goal-wait", t) });
		const pi = { sendMessage: messages.sendMessage, events, appendEntry: () => {} } as unknown as ExtensionAPI;
		const monitor = new MonitorAwareGoalContinuation(pi, () => false, () => {}, ticker);
		const goal = activeGoal("goal-live-3");
		await writeGoal({ baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"), threadId: ctx.sessionManager.getSessionId() }, goal);
		monitor.start(ctx);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });
		await events.flush();

		const endTurnWithText = async (text: string) => {
			const m = cleanAssistantStop();
			if (m.role !== "assistant") throw new Error("x");
			await monitor.afterAgentEnd({ ctx, goal, messages: [{ ...m, content: [{ type: "text", text }] }] });
		};

		for (let i = 0; i < 3; i++) {
			await endTurnWithText(`waiting turn ${i}`);
			const next = waitForSentCount(messages, messages.sent.length + 1);
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
			await next;
		}
		const all = messages.sent.map((s: any) => s.message.content);
		expect(all.some((c: string) => c.includes("<goal_stall_check>"))).toBe(false);
	});
});