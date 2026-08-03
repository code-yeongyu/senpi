import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_USER_GRACE_DELAY_MS } from "../../src/core/extensions/builtin/goal/continuation.ts";
import { admitAndQueueGoalContinuation } from "../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import {
	GOAL_MONITOR_CONTINUATION_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import {
	goalFilePath,
	readGoal,
	recordContinuationDelivered,
	updateGoal,
	writeGoal,
} from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { GOAL_WAIT_STATUS_KEY } from "../../src/core/extensions/builtin/goal/wait-ticker.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	createGoalStatusHarness,
	createSentMessageHarness,
	type GoalHandler,
	makeGoalContext,
	runGoalHandlers,
	TestEventBus,
	waitForGoalStatus,
	waitForSentCount,
} from "./goal-monitor-test-harness.ts";

function goalStoreRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

async function markCurrentGoalStale(ctx: ExtensionContext): Promise<void> {
	const goal = await readGoal(goalStoreRef(ctx));
	if (goal === null) throw new Error("Expected persisted goal");
	await recordContinuationDelivered(goalStoreRef(ctx), `${goal.id}:0/0:811c9dc5`);
}

function cleanAssistantStopWithText(text: string): AgentMessage {
	return assistantStopWithReason("stop", text);
}

function toolUsingContinuationMessages(turn: number): AgentMessage[] {
	const finalAssistant = cleanAssistantStopWithText(`progress ${turn}`);
	if (finalAssistant.role !== "assistant") throw new Error("Expected an assistant stop message");
	const toolCallId = `continuation-tool-${turn}`;
	return [
		{
			...finalAssistant,
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "true" } }],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: finalAssistant.timestamp,
		},
		finalAssistant,
	];
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

function createDirectMonitorHarness() {
	const harness = createSentMessageHarness();
	const events = new TestEventBus();
	const pi = {
		sendMessage: harness.sendMessage,
		events,
	} as unknown as ExtensionAPI;
	return { monitor: new MonitorAwareGoalContinuation(pi), harness, events };
}

async function runUserInitiatedTurn(handlers: Map<string, GoalHandler[]>, ctx: ExtensionContext): Promise<void> {
	await runGoalHandlers(
		handlers,
		"input",
		{ type: "input", inputId: "user-turn", text: "continue", source: "interactive" },
		ctx,
	);
	await runGoalHandlers(
		handlers,
		"input_disposition",
		{ type: "input_disposition", inputId: "user-turn", disposition: "started" },
		ctx,
	);
	await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);
}

describe("goal continuation while a monitor is active", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("reactivates only mechanical blocks on accepted direct input, including steering", async () => {
		const notices: string[] = [];
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-mechanical-recovery");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await updateGoal(goalStoreRef(ctx), { status: "blocked", reason: "continuation cap reached" }, "model");

		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", inputId: "recover", text: "continue", source: "interactive" },
			ctx,
		);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "recover", disposition: "started" },
			ctx,
		);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });

		await updateGoal(goalStoreRef(ctx), { status: "blocked", reason: "continuation cap reached" }, "model");
		await runGoalHandlers(
			handlers,
			"input",
			{
				type: "input",
				inputId: "steered-recover",
				text: "continue with this",
				source: "interactive",
				streamingBehavior: "steer",
			},
			ctx,
		);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "steered-recover", disposition: "queued" },
			ctx,
		);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });

		await updateGoal(goalStoreRef(ctx), { status: "blocked", reason: "waiting on a user decision" }, "model");
		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", inputId: "intentional", text: "hello", source: "rpc" },
			ctx,
		);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "intentional", disposition: "started" },
			ctx,
		);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "waiting on a user decision",
		});
	});

	it.each(["handled", "rejected"] as const)("keeps a mechanical block inert when input is %s", async (disposition) => {
		const notices: string[] = [];
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeGoalContext(notices, `thread-mechanical-${disposition}`);
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await updateGoal(goalStoreRef(ctx), { status: "blocked", reason: "continuation cap reached" }, "model");

		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", inputId: disposition, text: "continue", source: "interactive" },
			ctx,
		);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: disposition, disposition },
			ctx,
		);

		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "continuation cap reached",
		});
	});

	it("does not migrate an accepted input candidate to a replacement Goal", async () => {
		const notices: string[] = [];
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-input-goal-replacement");
		await tools.get("create_goal")?.execute("create", { objective: "Original goal" }, undefined, undefined, ctx);
		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", inputId: "replacement", text: "continue", source: "interactive" },
			ctx,
		);
		const replacement = {
			...activeGoal("replacement-goal"),
			threadId: ctx.sessionManager.getSessionId(),
			status: "blocked" as const,
			blockedReason: "continuation cap reached",
			blockedAt: 1,
			consecutiveContinuations: 5,
		};
		await writeGoal(goalStoreRef(ctx), replacement);

		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "replacement", disposition: "started" },
			ctx,
		);

		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			id: replacement.id,
			status: "blocked",
			consecutiveContinuations: 5,
		});
	});

	it("leaves stale goals active when accepted input steers the current execution", async () => {
		const notices: string[] = [];
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-steer-inert");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await markCurrentGoalStale(ctx);

		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", inputId: "steer", text: "adjust", source: "interactive", streamingBehavior: "steer" },
			ctx,
		);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "steer", disposition: "queued" },
			ctx,
		);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 0 });
	});

	it("leaves an active Goal active after an accepted follow-up while accounting the in-flight turn", async () => {
		const notices: string[] = [];
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-follow-up-pause");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		await markCurrentGoalStale(ctx);
		const before = await readGoal(goalStoreRef(ctx));
		if (before === null) throw new Error("Expected persisted goal");

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"input",
			{
				type: "input",
				inputId: "follow-up",
				text: "new task",
				source: "interactive",
				streamingBehavior: "followUp",
			},
			ctx,
		);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "follow-up", disposition: "queued" },
			ctx,
		);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop({ input: 100, output: 50 })] },
			ctx,
		);
		const after = await readGoal(goalStoreRef(ctx));
		expect(after?.status).toBe("active");
		expect((after?.tokensUsed ?? 0) - before.tokensUsed).toBe(150);
	});

	it("keeps overlapping rejected and handled inputs keyed while restoring the armed timer", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const { tools, handlers, sent, events } = harness;
		const ctx = await makeGoalContext(notices, "thread-overlapping-input-holds");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);

		for (const inputId of ["first", "second"]) {
			await runGoalHandlers(
				handlers,
				"input",
				{ type: "input", inputId, text: inputId, source: "interactive" },
				ctx,
			);
		}
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "first", disposition: "handled" },
			ctx,
		);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		expect(sent).toHaveLength(0);
		const restoredDelivery = waitForSentCount(harness, 1);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "second", disposition: "rejected" },
			ctx,
		);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		await restoredDelivery;
		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("restores the armed timer when Goal lookup fails before input disposition", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const { tools, handlers, sent, events } = harness;
		const ctx = await makeGoalContext(notices, "thread-input-read-failure");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);

		const ref = goalStoreRef(ctx);
		const persisted = await readGoal(ref);
		if (persisted === null) throw new Error("Expected persisted goal");
		await writeFile(goalFilePath(ref), '{"version":1,"goal":', "utf8");

		await expect(
			runGoalHandlers(
				handlers,
				"input",
				{ type: "input", inputId: "read-failure", text: "continue", source: "interactive" },
				ctx,
			),
		).rejects.toBeInstanceOf(SyntaxError);
		await writeGoal(ref, persisted);

		const restoredDelivery = waitForSentCount(harness, 1);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "read-failure", disposition: "rejected" },
			ctx,
		);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		await restoredDelivery;
		expect(sent).toHaveLength(1);
	});

	it("waits four minutes before continuing and announces the schedule", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const { tools, handlers, sent, events } = harness;
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
		const delayedDeliveryRecorded = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(1);
		await delayedDeliveryRecorded;
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("continues immediately after a clean continuation turn when no monitor is active", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const { tools, handlers, sent } = harness;
		const ctx = await makeGoalContext(notices, "thread-no-monitor");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		const deliveryRecorded = waitForSentCount(harness, 1);
		const turnCompleted = runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);
		await Promise.all([turnCompleted, deliveryRecorded]);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(notices).toHaveLength(0);
	});

	it("renders the user-grace countdown until delivery, then clears it", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const status = createGoalStatusHarness();
		const harness = createGoalHarness();
		const { tools, handlers, sent } = harness;
		const ctx = await makeGoalContext(notices, "thread-user-grace-countdown", {
			pendingMessages: false,
			status,
		});
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		const countdownStarted = waitForGoalStatus(
			status,
			(update) => update.key === GOAL_WAIT_STATUS_KEY && update.text?.includes("goal resumes in 10s") === true,
		);
		await runUserInitiatedTurn(handlers, ctx);
		await countdownStarted;
		expect(sent).toHaveLength(0);

		const countdownAdvanced = waitForGoalStatus(
			status,
			(update) => update.key === GOAL_WAIT_STATUS_KEY && update.text?.includes("goal resumes in 5s") === true,
		);
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS / 2);
		await countdownAdvanced;

		const deliveryRecorded = waitForSentCount(harness, 1);
		const countdownCleared = waitForGoalStatus(
			status,
			(update) => update.key === GOAL_WAIT_STATUS_KEY && update.text === undefined,
		);
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS / 2);
		await Promise.all([deliveryRecorded, countdownCleared]);

		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(status.updates.filter((update) => update.key === GOAL_WAIT_STATUS_KEY).at(-1)?.text).toBeUndefined();
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 1 });
	});

	it("clears the user-grace countdown and cancels delivery when new input is accepted", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const status = createGoalStatusHarness();
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-user-grace-countdown-cancel", {
			pendingMessages: false,
			status,
		});
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		const countdownStarted = waitForGoalStatus(
			status,
			(update) => update.key === GOAL_WAIT_STATUS_KEY && update.text?.includes("goal resumes in 10s") === true,
		);
		await runUserInitiatedTurn(handlers, ctx);
		await countdownStarted;

		const countdownCleared = waitForGoalStatus(
			status,
			(update) => update.key === GOAL_WAIT_STATUS_KEY && update.text === undefined,
		);
		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", inputId: "cancel-countdown", text: "new direction", source: "interactive" },
			ctx,
		);
		await countdownCleared;
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "cancel-countdown", disposition: "started" },
			ctx,
		);

		const waitStatusCount = status.updates.filter((update) => update.key === GOAL_WAIT_STATUS_KEY).length;
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS);
		expect(sent).toHaveLength(0);
		expect(status.updates.filter((update) => update.key === GOAL_WAIT_STATUS_KEY)).toHaveLength(waitStatusCount);
	});

	it("resets monitor-delayed repetition state when a goal pauses and resumes", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-monitor-repetition-resume");
		const { monitor, harness, events } = createDirectMonitorHarness();
		const { sent } = harness;
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
			const delayedDeliveryRecorded = waitForSentCount(harness, turn);
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
			await delayedDeliveryRecorded;
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
		const resumedDeliveryRecorded = waitForSentCount(harness, 3);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		await resumedDeliveryRecorded;

		expect(sent).toHaveLength(3);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("resets truncation recovery state when a goal pauses and resumes", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-length-resume");
		const { monitor, harness } = createDirectMonitorHarness();
		const { sent } = harness;
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

	it("queues one minimal recovery prompt after an output truncation", async () => {
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

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(sent[0]?.message.content).toContain("cut off");
		expect(sent[0]?.message.content).not.toContain("<untrusted_objective>");
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 1 });
	});

	it("blocks a second consecutive output truncation without queuing another prompt", async () => {
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

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "output truncation repeated",
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "length-exhausted" }),
		});
	});

	it("resets truncation recovery after a clean stop", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-length-reset");
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
			{ type: "agent_end", messages: [cleanAssistantStopWithText("completed a clean step")] },
			ctx,
		);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "second unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(3);
		expect(sent[2]?.message.content).toContain("cut off");
		expect(sent[2]?.message.content).not.toContain("<untrusted_objective>");
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "third unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(3);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "output truncation repeated",
		});
	});

	it("keeps admitting immediate continuations when every turn uses tools", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-immediate-tool-progress");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		for (let turn = 1; turn <= 9; turn++) {
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				handlers,
				"agent_end",
				{ type: "agent_end", messages: toolUsingContinuationMessages(turn) },
				ctx,
			);
		}

		expect(sent).toHaveLength(9);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			consecutiveContinuations: 1,
		});
		expect(events.emitted).not.toContainEqual(
			expect.objectContaining({
				channel: "goal_continuation_guard_tripped",
				data: expect.objectContaining({ reason: "cap" }),
			}),
		);
	});

	it("keeps admitting distinct progress beyond the continuation cap", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-immediate-distinct-progress");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		for (let turn = 1; turn <= 9; turn++) {
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				handlers,
				"agent_end",
				{ type: "agent_end", messages: [cleanAssistantStopWithText(`progress ${turn}`)] },
				ctx,
			);
		}

		expect(sent).toHaveLength(9);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			consecutiveContinuations: 1,
		});
		expect(events.emitted).not.toContainEqual(
			expect.objectContaining({
				channel: "goal_continuation_guard_tripped",
				data: expect.objectContaining({ reason: "cap" }),
			}),
		);
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
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "continuation cap reached",
			consecutiveContinuations: 0,
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

	it("fails closed instead of delivering an unsigned continuation", async () => {
		const notices: string[] = [];
		const { tools } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-unsigned-continuation");
		await tools
			.get("create_goal")
			?.execute("create", { objective: "Continue without a signature" }, undefined, undefined, ctx);
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal === null) throw new Error("Expected persisted goal");

		let continuationMarked = false;
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
						path: "immediate",
						lastStopReason: "stop",
						consecutiveContinuations: goal.consecutiveContinuations ?? 0,
						lastContinuationSignature: goal.lastContinuationSignature,
						currentSignature: undefined,
						consecutiveLengthRecoveries: 0,
						recentNormalizedOutputHashes: [],
						toollessContinuationStreak: 0,
						continuationPending: false,
					},
					content: () => "Continue",
					markContinuationPending: () => {
						continuationMarked = true;
					},
				},
			),
		).rejects.toThrow("without a progress signature");

		expect(queued).toBe(false);
		expect(continuationMarked).toBe(false);
		expect((await readGoal(goalStoreRef(ctx)))?.consecutiveContinuations ?? 0).toBe(0);
	});
});
