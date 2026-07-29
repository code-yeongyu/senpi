import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitAndQueueGoalContinuation } from "../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import {
	GOAL_MONITOR_CONTINUATION_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import {
	readGoal,
	recordContinuationDelivered,
	updateGoal,
	writeGoal,
} from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	TestEventBus,
} from "./goal-monitor-test-harness.ts";

function goalStoreRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function cleanAssistantStopWithText(text: string): AgentMessage {
	return assistantStopWithReason("stop", text);
}

function assistantStopWithReason(stopReason: "stop" | "length", text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected assistant stop message");
	return { ...message, content: [{ type: "text", text }], stopReason };
}

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

function createDirectMonitorHarness(): { monitor: MonitorAwareGoalContinuation; sent: string[]; events: TestEventBus } {
	const sent: string[] = [];
	const events = new TestEventBus();
	const pi = {
		sendMessage: (message: { readonly content: string }) => sent.push(message.content),
		events,
	} as unknown as ExtensionAPI;
	return { monitor: new MonitorAwareGoalContinuation(pi), sent, events };
}

describe("goal continuation while a monitor is active", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("waits four minutes before continuing and announces the schedule", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-monitor-cadence");
		await tools.get("create_goal")?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);

		expect(sent).toHaveLength(0);
		expect(notices).toEqual([expect.stringMatching(/4 minutes/i)]);
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_scheduled",
			data: expect.objectContaining({ delayMs: 240_000 }),
		});

		await vi.advanceTimersByTimeAsync(239_999);
		expect(sent).toHaveLength(0);
		const resumed = events.waitFor("goal_continuation_resumed");
		await vi.advanceTimersByTimeAsync(1);
		await resumed;
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("continues immediately after a clean continuation turn when no monitor is active", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-no-monitor");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(notices).toHaveLength(0);
	});

	it("shares the persisted eight-delivery cap with monitor-delayed continuations across restart", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const initial = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-monitor-shared-cap");
		await initial.tools
			.get("create_goal")
			?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(initial.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		for (let delivery = 1; delivery <= 4; delivery++) {
			await runGoalHandlers(initial.handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				initial.handlers,
				"agent_end",
				{ type: "agent_end", messages: [cleanAssistantStopWithText(`immediate progress ${delivery}`)] },
				ctx,
			);
		}
		expect(initial.sent).toHaveLength(4);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			consecutiveContinuations: 4,
		});
		await runGoalHandlers(initial.handlers, "session_shutdown", { type: "session_shutdown" }, ctx);

		const restarted = createGoalHarness();
		await runGoalHandlers(restarted.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		restarted.events.emit("terminal_monitor_state", { activeCount: 1 });
		await restarted.events.flush();

		for (let delivery = 5; delivery <= 8; delivery++) {
			await runGoalHandlers(restarted.handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				restarted.handlers,
				"agent_end",
				{ type: "agent_end", messages: [cleanAssistantStopWithText(`monitor progress ${delivery}`)] },
				ctx,
			);
			const resumed = restarted.events.waitFor("goal_continuation_resumed");
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
			await resumed;
		}

		expect(restarted.sent).toHaveLength(4);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			consecutiveContinuations: 8,
		});

		await runGoalHandlers(restarted.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			restarted.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("monitor progress 9")] },
			ctx,
		);
		const capped = restarted.events.waitFor("goal_continuation_guard_tripped");
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		await capped;

		expect(initial.sent).toHaveLength(4);
		expect(restarted.sent).toHaveLength(4);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "continuation cap reached",
			consecutiveContinuations: 8,
		});
	});

	it.skipIf(process.platform === "win32")(
		"queues no monitor-delayed continuation when delivery accounting cannot persist",
		async () => {
			const notices: string[] = [];
			const ctx = await makeGoalContext(notices, "thread-monitor-persistence-failure");
			const goal = activeGoal("goal-monitor-persistence-failure");
			const ref = goalStoreRef(ctx);
			await writeGoal(ref, goal);
			await chmod(ref.baseDir, 0o500);

			const sent: string[] = [];
			let continuationMarked = false;
			let persistenceError: unknown;
			try {
				await admitAndQueueGoalContinuation(
					{
						sendMessage: (message: { readonly content: string }) => sent.push(message.content),
					} as unknown as ExtensionAPI,
					ctx,
					goal,
					{
						input: {
							isIdle: true,
							hasPendingMessages: false,
							path: "monitorDelayed",
							lastStopReason: "stop",
							consecutiveContinuations: 0,
							lastContinuationSignature: undefined,
							currentSignature: `${goal.id}:0/0:failure`,
							consecutiveLengthRecoveries: 0,
							recentNormalizedOutputHashes: [],
							toollessContinuationStreak: 0,
							endedTurnWasUserInitiated: false,
							continuationPending: false,
						},
						content: () => "Continue",
						markContinuationPending: () => {
							continuationMarked = true;
						},
					},
				);
			} catch (error) {
				persistenceError = error;
			} finally {
				await chmod(ref.baseDir, 0o700);
			}

			expect(sent).toHaveLength(0);
			expect(continuationMarked).toBe(false);
			expect(persistenceError).toBeInstanceOf(Error);
			expect((await readGoal(ref))?.consecutiveContinuations ?? 0).toBe(0);
		},
	);

	it("pauses immediately on direct user input without grace delay", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-user-direct-pauses");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		const inputReceived = events.waitFor("goal_pause_triggered");
		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", text: "Answer me directly", source: "interactive" },
			ctx,
		);
		expect(await inputReceived).toMatchObject({ reason: "user-input" });
		await runGoalHandlers(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("answered user directly")] },
			ctx,
		);

		// Verify direct input immediately paused with zero continuation
		expect(sent).toHaveLength(0);
		const goal = await readGoal(goalStoreRef(ctx));
		expect(goal).toMatchObject({ status: "paused", consecutiveContinuations: 0 });
		// Even if monitor settles, no continuation should be queued
		expect(events.emitted.filter((e) => e.channel === "goal_continuation_resumed")).toHaveLength(0);
	});

	it("pauses on direct input before monitor settles, zero continuation even if monitor clears", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-user-input-monitor-clear");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		// Set an active monitor
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();

		// Subscribe before sending direct user input
		const pauseTriggered = events.waitFor("goal_pause_triggered");

		await runGoalHandlers(handlers, "input", { type: "input", text: "Respond to me", source: "interactive" }, ctx);
		expect(await pauseTriggered).toMatchObject({ reason: "user-input" });
		events.emit("terminal_monitor_state", { activeCount: 0 });
		await events.flush();

		await runGoalHandlers(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("answered directly")] },
			ctx,
		);

		// Direct user input pauses immediately, zero continuations even if monitor settles
		expect(sent).toHaveLength(0);
		const goal = await readGoal(goalStoreRef(ctx));
		expect(goal).toMatchObject({ status: "paused", consecutiveContinuations: 0 });
		expect(events.emitted.filter((e) => e.channel === "goal_continuation_resumed")).toHaveLength(0);
	});

	it("resets monitor-delayed repetition state when a goal pauses and resumes", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-monitor-repetition-resume");
		const { monitor, sent, events } = createDirectMonitorHarness();
		const goal = activeGoal("goal-monitor-repetition-resume");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();

		for (let turn = 1; turn <= 2; turn++) {
			await monitor.afterAgentEnd({
				ctx,
				goal,
				messages: [cleanAssistantStopWithText("unchanged monitor output")],
			});
			const continuationResumed = events.waitFor("goal_continuation_resumed");
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
			await continuationResumed;
		}

		const paused = await updateGoal(goalStoreRef(ctx), { status: "paused" }, "user");
		monitor.syncGoal(paused);
		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		monitor.syncGoal(resumed);
		await monitor.afterAgentEnd({
			ctx,
			goal: resumed,
			messages: [cleanAssistantStopWithText("unchanged monitor output")],
		});
		const continuationResumed = events.waitFor("goal_continuation_resumed");
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		await continuationResumed;

		expect(sent).toHaveLength(3);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("resets truncation recovery state when a goal pauses and resumes", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-length-resume");
		const { monitor, sent } = createDirectMonitorHarness();
		const goal = activeGoal("goal-length-resume");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		await monitor.afterAgentEnd({
			ctx,
			goal,
			messages: [assistantStopWithReason("length", "first unfinished implementation")],
		});
		expect(sent).toHaveLength(1);

		const paused = await updateGoal(goalStoreRef(ctx), { status: "paused" }, "user");
		monitor.syncGoal(paused);
		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		monitor.syncGoal(resumed);
		await monitor.afterAgentEnd({
			ctx,
			goal: resumed,
			messages: [assistantStopWithReason("length", "second unfinished implementation")],
		});

		expect(sent).toHaveLength(2);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("pauses without recovery after an output truncation", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-length-minimal");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "paused", consecutiveContinuations: 0 });
	});

	it("does not queue after another terminal event while truncation-paused", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-length-exhausted");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "first unfinished implementation")] },
			ctx,
		);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "second unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "paused" });
		expect(events.emitted).not.toContainEqual(
			expect.objectContaining({ channel: "goal_continuation_guard_tripped" }),
		);
	});

	it("continues normally after an explicit truncation-pause resume and clean stop", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-length-reset");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "unfinished implementation")] },
			ctx,
		);
		expect(sent).toHaveLength(0);

		await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("completed a clean step")] },
			ctx,
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("makes the eighth clean immediate delivery final and pauses the ninth evaluation", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-immediate-cap");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		for (let turn = 1; turn <= 8; turn++) {
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				handlers,
				"agent_end",
				{ type: "agent_end", messages: [cleanAssistantStopWithText(`progress ${turn}`)] },
				ctx,
			);
		}

		expect(sent).toHaveLength(8);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 8 });

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("progress 9")] },
			ctx,
		);

		expect(sent).toHaveLength(8);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "continuation cap reached",
			consecutiveContinuations: 8,
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "cap", count: 8 }),
		});
	});

	it("silently skips a stale continuation after two real agent_end cycles with unchanged progress", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-stale-real-cycles");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("No progress yet")] },
			ctx,
		);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("No progress yet")] },
			ctx,
		);

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 1 });
		expect(events.emitted).not.toContainEqual(
			expect.objectContaining({ channel: "goal_continuation_guard_tripped" }),
		);
	});

	it("counts session_start deliveries and applies the persisted cap on a later session_start", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-session-start-cap");
		await tools.get("create_goal")?.execute("create", { objective: "Resume work" }, undefined, undefined, ctx);

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ consecutiveContinuations: 1 });

		const goal = await readGoal(goalStoreRef(ctx));
		if (goal === null) throw new Error("Expected persisted goal");
		for (let count = 2; count <= 8; count++) {
			await recordContinuationDelivered(goalStoreRef(ctx), `${goal.id}:0/0:seed-${count}`);
		}
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		const guardTripped = events.waitFor("goal_continuation_guard_tripped");
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);
		expect(await guardTripped).toMatchObject({ reason: "cap", count: 8 });

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "paused",
			blockedReason: "continuation cap reached",
			consecutiveContinuations: 8,
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "cap", count: 8 }),
		});
	});

	it("does not queue a second session_start continuation while the first is pending", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-single-flight");
		await tools.get("create_goal")?.execute("create", { objective: "Resume once" }, undefined, undefined, ctx);

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 1 });
	});

	it("fails closed when a continuation has no delivery signature", async () => {
		const notices: string[] = [];
		const { tools } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-unsigned-continuation");
		await tools
			.get("create_goal")
			?.execute("create", { objective: "Continue without a signature" }, undefined, undefined, ctx);
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal === null) throw new Error("Expected persisted goal");

		const sent: string[] = [];
		let continuationMarked = false;
		await expect(
			admitAndQueueGoalContinuation(
				{
					sendMessage: (message: { readonly content: string }) => sent.push(message.content),
				} as unknown as ExtensionAPI,
				ctx,
				goal,
				{
					input: {
						isIdle: true,
						hasPendingMessages: false,
						path: "immediate",
						lastStopReason: "stop",
						consecutiveContinuations: goal.consecutiveContinuations ?? 0,
						lastContinuationSignature: goal.lastContinuationSignature,
						currentSignature: undefined,
						consecutiveLengthRecoveries: 0,
						recentNormalizedOutputHashes: [],
						toollessContinuationStreak: 0,
						endedTurnWasUserInitiated: false,
						continuationPending: false,
					},
					content: () => "Continue",
					markContinuationPending: () => {
						continuationMarked = true;
					},
				},
			),
		).rejects.toThrow("without a delivery signature");

		expect(sent).toHaveLength(0);
		expect(continuationMarked).toBe(false);
		expect((await readGoal(goalStoreRef(ctx)))?.consecutiveContinuations ?? 0).toBe(0);
	});
});
