import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_CONTINUATION_RESUMED_EVENT,
	GOAL_CONTINUATION_SCHEDULED_EVENT,
	GOAL_CONTINUATION_TIMER_STATE_EVENT,
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { buildGoalStallNotice } from "../../src/core/extensions/builtin/goal/prompt.ts";
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

/** Default `askUser.timeoutMinutes` (30) expressed in ms: the idle deadline of a pending question. */
const ASK_USER_QUESTION_TIMEOUT_MS = 1_800_000;

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

	it("parks the goal on the pending question deadline instead of the periodic backstop", async () => {
		vi.useFakeTimers();
		const ctx = await makeGoalContext([], "thread-ask-user-pending");
		const harness = createMonitorHarness();
		const goal = activeGoal("goal-ask-user-pending");
		await persistGoal(ctx, goal);
		harness.monitor.start(ctx);
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "ask-user",
			activeCount: 1,
			items: [{ id: "call-1", description: "Pick a database" }],
		});
		await harness.events.flush();

		await endTurn(harness.monitor, ctx, goal);

		expect(emitted(harness.events, GOAL_CONTINUATION_SCHEDULED_EVENT)[0]).toMatchObject({
			delayMs: ASK_USER_QUESTION_TIMEOUT_MS,
			wakeSources: { "ask-user": 1 },
		});
		// The 270s backstop must not re-prompt the model while the user is deciding.
		await vi.advanceTimersByTimeAsync(ASK_USER_QUESTION_TIMEOUT_MS - 1);
		expect(harness.sent).toHaveLength(0);

		// The question's own deadline is the single armed wake, and it fires once.
		const delivered = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(1);
		await delivered;
		expect(harness.sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(ASK_USER_QUESTION_TIMEOUT_MS);
		expect(harness.sent).toHaveLength(1);
	});

	it("wakes the goal exactly once when the pending question drains before its deadline", async () => {
		vi.useFakeTimers();
		const ctx = await makeGoalContext([], "thread-ask-user-drain");
		const harness = createMonitorHarness();
		const goal = activeGoal("goal-ask-user-drain");
		await persistGoal(ctx, goal);
		harness.monitor.start(ctx);
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "ask-user",
			activeCount: 1,
			items: [{ id: "call-1", description: "Pick a database" }],
		});
		await harness.events.flush();
		await endTurn(harness.monitor, ctx, goal);

		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS * 3);
		expect(harness.sent).toHaveLength(0);
		// The parked timer is still armed: no backstop fire consumed it on the way.
		expect(emitted(harness.events, GOAL_CONTINUATION_TIMER_STATE_EVENT).at(-1)).toEqual({
			armed: true,
			kind: "monitor",
		});

		const delivered = waitForSentCount(harness, 1);
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, { source: "ask-user", activeCount: 0 });
		await harness.events.flush();
		await vi.advanceTimersByTimeAsync(1_000);
		await delivered;
		expect(harness.sent).toHaveLength(1);

		// The drain fire replaced the parked timer: nothing fires afterwards.
		await vi.advanceTimersByTimeAsync(ASK_USER_QUESTION_TIMEOUT_MS);
		expect(harness.sent).toHaveLength(1);
	});

	it("tells a stalled goal to wait for the pending question instead of re-asking", () => {
		const notice = buildGoalStallNotice(3, { liveSources: ["ask-user"] });

		expect(notice).toContain(
			"- A question to the user is pending; wait for the answer or the timeout, do not ask it again, and do not treat the wait as a stall.",
		);
		expect(notice).not.toContain("Inspect the live ask-user channel");
	});

	it("maps continuation-hold events onto the monitor direct-input hold", async () => {
		const harness = createMonitorHarness();
		const holdSpy = vi.spyOn(harness.monitor, "holdDirectInput");
		const resolveSpy = vi.spyOn(harness.monitor, "resolveDirectInput");

		harness.events.emit("continuation_hold_state", {
			source: "loop-guard-hard-stop",
			active: true,
		});
		await harness.events.flush();
		expect(holdSpy).toHaveBeenCalledWith("external:loop-guard-hard-stop");
		harness.events.emit("continuation_hold_state", {
			source: "loop-guard-hard-stop",
			active: false,
		});
		await harness.events.flush();
		expect(resolveSpy).toHaveBeenCalledWith("external:loop-guard-hard-stop", false);
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
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
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
