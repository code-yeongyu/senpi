import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createSentMessageHarness,
	makeGoalContext,
	TestEventBus,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const monitors: MonitorAwareGoalContinuation[] = [];
afterEach(async () => {
	for (const monitor of monitors.splice(0)) monitor.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
	await cleanupGoalMonitorTempDirs();
});

async function parkedWait() {
	vi.useFakeTimers();
	const state = { pendingMessages: false, idle: true };
	const base = await makeGoalContext([], "issue-4050", state);
	const ctx = { ...base, isIdle: () => state.idle };
	const messages = createSentMessageHarness();
	const events = new TestEventBus();
	const pi = { events, sendMessage: messages.sendMessage } as unknown as ExtensionAPI;
	const monitor = new MonitorAwareGoalContinuation(pi);
	monitors.push(monitor);
	const goal: Goal = {
		id: "goal-4050",
		threadId: ctx.sessionManager.getSessionId(),
		objective: "Finish the monitored work",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	await writeGoal(
		{ baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"), threadId: goal.threadId },
		goal,
	);
	monitor.start(ctx);
	events.emit("terminal_monitor_state", { activeCount: 1 });
	await events.flush();
	return { state, ctx, goal, monitor, messages };
}

// senpi#4050: the monitor wait owns liveness even if its primary callback is lost or declined.
describe("parked goal wait deadline", () => {
	it("ends the wait within one second of its due time when the primary callback is dropped", async () => {
		const { monitor, ctx, goal, messages } = await parkedWait();
		const schedule = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
			schedule(delay === GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS ? () => {} : callback, delay, ...args),
		);
		await monitor.afterAgentEnd({ ctx, goal, messages: [cleanAssistantStop()] });

		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS + 1_000);

		expect(monitor.scheduledContinuation()).toBeUndefined();
		await waitForSentCount(messages, 1);
		expect(messages.sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
		expect(messages.sent).toHaveLength(1);
	});

	it.each(["busy", "pending"] as const)(
		"keeps a declined %s wake recoverable when the session settles",
		async (reason) => {
			const { monitor, ctx, goal, messages, state } = await parkedWait();
			await monitor.afterAgentEnd({ ctx, goal, messages: [cleanAssistantStop()] });
			state.idle = reason !== "busy";
			state.pendingMessages = reason === "pending";

			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
			state.idle = true;
			state.pendingMessages = false;
			await monitor.afterAgentSettled();

			expect(messages.sent).toHaveLength(1);
			expect(monitor.scheduledContinuation()).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(messages.sent).toHaveLength(1);
		},
	);

	it("replaces a declined provider retry with a monitor wait after a successful run", async () => {
		const { monitor, ctx, goal, messages, state } = await parkedWait();
		const failure = {
			...cleanAssistantStop(),
			stopReason: "error" as const,
			errorMessage: "server_error: upstream unavailable",
		};
		const event = { type: "agent_end" as const, messages: [failure], aborted: false, willRetry: false };
		for (let attempt = 0; attempt < 2; attempt++) {
			await monitor.afterProviderFailure({ ctx, goal, messages: [failure], event, willRetry: false });
			await monitor.afterAgentSettled();
		}
		expect(messages.sent).toHaveLength(1);
		expect(monitor.scheduledContinuation()).toBe("providerRetry");
		state.idle = false;

		await vi.advanceTimersByTimeAsync(15_000);
		await monitor.afterAgentEnd({ ctx, goal, messages: [cleanAssistantStop()] });
		state.idle = true;
		await monitor.afterAgentSettled();

		expect(messages.sent).toHaveLength(1);
		expect(monitor.scheduledContinuation()).toBe("monitor");
	});
});
