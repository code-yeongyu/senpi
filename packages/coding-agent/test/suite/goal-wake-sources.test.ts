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
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanupRoots,
	createHarness as createAppServerHarness,
	threadIdFromResponse,
} from "./app-server-thread-handlers-harness.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
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

function createMonitorHarness() {
	const messages = createSentMessageHarness();
	const events = new TestEventBus();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		sendMessage: messages.sendMessage,
		events,
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	return {
		monitor: new MonitorAwareGoalContinuation(pi),
		events,
		entries,
		...messages,
	};
}

async function endTurn(monitor: MonitorAwareGoalContinuation, ctx: ExtensionContext, goal: Goal): Promise<void> {
	await monitor.afterAgentEnd({ ctx, goal, messages: [cleanAssistantStop()] });
}

function emitted(events: TestEventBus, channel: string): Record<string, unknown>[] {
	return events.emitted
		.filter((event) => event.channel === channel)
		.map((event) => event.data as Record<string, unknown>);
}

describe("goal wake sources", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await Promise.all([cleanupGoalMonitorTempDirs(), cleanupRoots()]);
	});

	it("defers an active goal while a background bash session is registered", async () => {
		vi.useFakeTimers();
		const ctx = await makeGoalContext([], "thread-background-registered");
		const harness = createMonitorHarness();
		const goal = activeGoal("goal-background-registered");
		await persistGoal(ctx, goal);
		harness.monitor.start(ctx);
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "terminal-background-sessions",
			activeCount: 1,
			items: [{ id: "bash-1", description: "build", startedAtMs: 1 }],
		});
		await harness.events.flush();

		await endTurn(harness.monitor, ctx, goal);

		expect(harness.sent).toHaveLength(0);
		expect(emitted(harness.events, GOAL_CONTINUATION_SCHEDULED_EVENT)[0]).toMatchObject({
			activeMonitorCount: 1,
			wakeSources: { "terminal-background-sessions": 1 },
		});
	});

	it("fires after the micro-grace when a background session exits without a notification", async () => {
		vi.useFakeTimers();
		const ctx = await makeGoalContext([], "thread-background-drain");
		const harness = createMonitorHarness();
		const goal = activeGoal("goal-background-drain");
		await persistGoal(ctx, goal);
		harness.monitor.start(ctx);
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "terminal-background-sessions",
			activeCount: 1,
		});
		await harness.events.flush();
		await endTurn(harness.monitor, ctx, goal);

		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "terminal-background-sessions",
			activeCount: 0,
		});
		await harness.events.flush();
		await vi.advanceTimersByTimeAsync(999);
		expect(harness.sent).toHaveLength(0);

		const delivered = waitForSentCount(harness, 1);
		const resumed = waitForEventCount(harness.events, GOAL_CONTINUATION_RESUMED_EVENT, 1);
		await vi.advanceTimersByTimeAsync(1);
		await Promise.all([delivered, resumed]);
		expect(emitted(harness.events, GOAL_CONTINUATION_RESUMED_EVENT)[0]).toMatchObject({
			iteration: 1,
			activeMonitorCount: 0,
			wakeSources: { "terminal-background-sessions": 0 },
		});
	});

	it("queues a continuation when thread/goal/set activates an idle session", async () => {
		const { connection, registry, root, threads } = await createAppServerHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 1, method: "thread/start", params: { cwd: root } }),
		);
		const session = threads.getLoadedThread(threadId).session as unknown as {
			onExtensionEvent?: (channel: string, handler: (data: unknown) => void) => () => void;
		};
		expect(session.onExtensionEvent).toBeTypeOf("function");
		const scheduled = Promise.withResolvers<unknown>();
		const unsubscribe = session.onExtensionEvent?.(GOAL_CONTINUATION_SCHEDULED_EVENT, scheduled.resolve);

		await registry.dispatch(connection, {
			id: 2,
			method: "thread/goal/set",
			params: { threadId, objective: "Resume from RPC" },
		});

		await expect(Promise.race([scheduled.promise, timeoutAfter(2_000)])).resolves.toMatchObject({
			goalId: expect.any(String),
			reason: "goal_store_changed",
		});
		unsubscribe?.();
	});

	it("sums a terminal monitor with a background session and keeps waiting when only one drains", async () => {
		vi.useFakeTimers();
		const ctx = await makeGoalContext([], "thread-mixed-wakes");
		const harness = createMonitorHarness();
		const goal = activeGoal("goal-mixed-wakes");
		await persistGoal(ctx, goal);
		harness.monitor.start(ctx);
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "terminal-background-sessions",
			activeCount: 1,
		});
		await harness.events.flush();
		await endTurn(harness.monitor, ctx, goal);

		expect(emitted(harness.events, GOAL_CONTINUATION_SCHEDULED_EVENT)[0]).toMatchObject({
			activeMonitorCount: 2,
			wakeSources: { "terminal-background-sessions": 1, "terminal-monitors": 1 },
		});

		harness.events.emit("terminal_monitor_state", { activeCount: 0 });
		await harness.events.flush();
		const delivered = waitForSentCount(harness, 1);
		const resumed = waitForEventCount(harness.events, GOAL_CONTINUATION_RESUMED_EVENT, 1);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS);
		await Promise.all([delivered, resumed]);
		expect(emitted(harness.events, GOAL_CONTINUATION_RESUMED_EVENT)[0]).toMatchObject({
			activeMonitorCount: 1,
			wakeSources: { "terminal-background-sessions": 1, "terminal-monitors": 0 },
		});
	});
});

function timeoutAfter(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error("Timed out waiting for goal continuation scheduling")), ms);
	});
}
