import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_CONTINUATION_RESUMED_EVENT,
	GOAL_CONTINUATION_SCHEDULED_EVENT,
	GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { writeGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { GoalWaitTicker } from "../../src/core/extensions/builtin/goal/wait-ticker.ts";
import {
	isWakeSourceStateEvent,
	WAKE_SOURCE_STATE_EVENT,
} from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalStatusHarness,
	createSentMessageHarness,
	makeGoalContext,
	TestEventBus,
	waitForEventCount,
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

function createHarness(status = createGoalStatusHarness()) {
	const messages = createSentMessageHarness();
	const events = new TestEventBus();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const ticker = new GoalWaitTicker({ render: (ctx, text) => ctx.ui.setStatus("goal-wait", text) });
	const pi = {
		sendMessage: messages.sendMessage,
		events,
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	return {
		monitor: new MonitorAwareGoalContinuation(
			pi,
			() => false,
			() => {},
			ticker,
		),
		events,
		entries,
		status,
		...messages,
	};
}

async function endTurn(monitor: MonitorAwareGoalContinuation, ctx: ExtensionContext, goal: Goal): Promise<void> {
	await monitor.afterAgentEnd({ ctx, goal, messages: [cleanAssistantStop()] });
}

function channelEvents(events: TestEventBus, channel: string): Record<string, unknown>[] {
	return events.emitted
		.filter((event) => event.channel === channel)
		.map((event) => event.data as Record<string, unknown>);
}

describe("wake source state contract", () => {
	it("accepts open source names and extra fields while rejecting malformed snapshots", () => {
		expect(isWakeSourceStateEvent({ source: "custom-worker", activeCount: 0 })).toBe(true);
		expect(
			isWakeSourceStateEvent({
				source: "senpi-task",
				activeCount: 1,
				channels: [{ id: "task-1", description: "child", startedAtMs: 123 }],
			}),
		).toBe(true);
		expect(isWakeSourceStateEvent({ source: "", activeCount: 1 })).toBe(false);
		expect(isWakeSourceStateEvent({ source: "senpi-task", activeCount: 0.5 })).toBe(true);
		expect(isWakeSourceStateEvent({ source: "senpi-task", activeCount: Number.NaN })).toBe(false);
		expect(isWakeSourceStateEvent(null)).toBe(false);
	});
});

describe("goal continuation resumption channels", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("delays an active goal while a senpi task channel is live", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-task-channel");
		const { monitor, events, sent } = createHarness();
		const goal = activeGoal("goal-task-channel");
		await persistGoal(ctx, goal);
		monitor.start(ctx);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });
		await events.flush();

		await endTurn(monitor, ctx, goal);

		expect(sent).toHaveLength(0);
		expect(channelEvents(events, GOAL_CONTINUATION_SCHEDULED_EVENT)).toHaveLength(1);
	});

	it("keeps the timer and toolless streak until the total across sources reaches zero", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-total-zero");
		const harness = createHarness();
		const { monitor, events, sent } = harness;
		const goal = activeGoal("goal-total-zero");
		await persistGoal(ctx, goal);
		monitor.start(ctx);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 1 });
		await events.flush();

		for (let turn = 1; turn <= 2; turn++) {
			await endTurn(monitor, ctx, goal);
			const delivered = waitForSentCount(harness, turn);
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS);
			await delivered;
		}

		await endTurn(monitor, ctx, goal);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 0 });
		await events.flush();
		const thirdDelivery = waitForSentCount(harness, 3);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS);
		await thirdDelivery;
		expect(sent[2]?.message.content).toContain("<goal_stall_check>");

		await endTurn(monitor, ctx, goal);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 0 });
		await events.flush();
		const drainDelivery = waitForSentCount(harness, 4);
		await vi.advanceTimersByTimeAsync(1_000);
		await drainDelivery;
		expect(sent).toHaveLength(4);
	});

	it("treats legacy and generalized terminal-monitor snapshots as idempotent writes", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const status = createGoalStatusHarness();
		const ctx = await makeGoalContext(notices, "thread-dual-terminal", { pendingMessages: false, status });
		const { monitor, events } = createHarness(status);
		const goal = activeGoal("goal-dual-terminal");
		await persistGoal(ctx, goal);
		monitor.start(ctx);
		events.emit("terminal_monitor_state", { activeCount: 2 });
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 2 });
		await events.flush();

		await endTurn(monitor, ctx, goal);

		expect(status.updates.at(-1)?.text).toContain("2 wake sources on duty");
		expect(status.updates.at(-1)?.text).not.toContain("4 wake sources");
		expect(channelEvents(events, GOAL_CONTINUATION_SCHEDULED_EVENT)[0]).toMatchObject({
			activeMonitorCount: 2,
			wakeSources: { "terminal-monitors": 2 },
		});
	});

	it("preserves first-start snapshots but clears them on a same-instance session replacement", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-pre-start");
		const harness = createHarness();
		const { monitor, events, sent } = harness;
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-codemode", activeCount: 1 });
		await events.flush();

		monitor.start(ctx);
		const firstSessionGoal = activeGoal("goal-first-session");
		await persistGoal(ctx, firstSessionGoal);
		await endTurn(monitor, ctx, firstSessionGoal);
		expect(channelEvents(events, GOAL_CONTINUATION_SCHEDULED_EVENT)).toHaveLength(1);
		expect(sent).toHaveLength(0);

		monitor.start(ctx);
		const replacementSessionGoal = activeGoal("goal-replacement-session");
		await persistGoal(ctx, replacementSessionGoal);
		await endTurn(monitor, ctx, replacementSessionGoal);
		expect(sent).toHaveLength(1);
	});

	it("keeps terminal monitor telemetry and adds per-source counts on schedule and resume", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-channel-telemetry");
		const harness = createHarness();
		const { monitor, events, entries } = harness;
		const goal = activeGoal("goal-channel-telemetry");
		await persistGoal(ctx, goal);
		monitor.start(ctx);
		events.emit("terminal_monitor_state", { activeCount: 2 });
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });
		await events.flush();

		await endTurn(monitor, ctx, goal);
		const expected = {
			activeMonitorCount: 3,
			wakeSources: { "senpi-task": 1, "terminal-monitors": 2 },
		};
		expect(channelEvents(events, GOAL_CONTINUATION_SCHEDULED_EVENT)[0]).toMatchObject(expected);
		expect(entries[0]?.data).toMatchObject(expected);

		const delivered = waitForSentCount(harness, 1);
		const resumed = waitForEventCount(events, GOAL_CONTINUATION_RESUMED_EVENT, 1);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS);
		await Promise.all([delivered, resumed]);
		expect(channelEvents(events, GOAL_CONTINUATION_RESUMED_EVENT)[0]).toMatchObject(expected);
		expect(entries[1]?.data).toMatchObject(expected);
	});
});
