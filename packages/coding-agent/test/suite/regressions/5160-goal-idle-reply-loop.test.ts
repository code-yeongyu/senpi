import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as continuation from "../../../src/core/extensions/builtin/goal/continuation.ts";
import {
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { readGoal, resetContinuationStreak, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import {
	MONITOR_NOTIFICATION_CUSTOM_TYPE,
	WAKE_SOURCE_STATE_EVENT,
} from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	createSentMessageHarness,
	makeGoalContext,
	runGoalHandlers,
	TestEventBus,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const { GOAL_USER_GRACE_DELAY_MS } = continuation;
// The idle-reply streak the LEAD approved; a literal, so this file runs (and fails for the right reason) on main too.
const IDLE_REPLY_STREAK = 8;

// Reworded idle replies: no two normalize to the same text, so an exact-hash streak never forms.
const IDLE_REPLIES = [
	"I read this as a no-verdict wake - I'll remain idle and stop immediately. Waiting.",
	"I read this as another no-verdict wake - I'll stay idle and stop immediately. Waiting.",
	"Still no verdict; staying idle and stopping now.",
	"No verdict yet, so I remain idle.",
] as const;

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
		objective: "Keep moving",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function reply(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected an assistant stop message");
	return { ...message, content: [{ type: "text", text }] };
}

function progressTurn(turn: number): AgentMessage[] {
	const final = reply(`edited step ${turn}`);
	if (final.role !== "assistant") throw new Error("Expected an assistant stop message");
	const toolCallId = `idle-loop-tool-${turn}`;
	return [
		{
			...final,
			content: [{ type: "toolCall", id: toolCallId, name: "edit", arguments: { path: `src/step-${turn}.ts` } }],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "edit",
			content: [{ type: "text", text: `Edited src/step-${turn}.ts` }],
			isError: false,
			timestamp: final.timestamp,
		},
		final,
	];
}

function recheckTurn(turn: number): AgentMessage[] {
	const final = reply(`Checked again (${turn}); the verdict file is still absent.`);
	if (final.role !== "assistant") throw new Error("Expected an assistant stop message");
	const toolCallId = `idle-loop-recheck-${turn}`;
	return [
		{
			...final,
			content: [
				{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `test -f verdict.md # ${turn}` } },
			],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "verdict.md: absent" }],
			isError: false,
			timestamp: final.timestamp,
		},
		final,
	];
}

/** The goal's continuation timer transitions, in order: which kind was armed or fired. */
function timerStates(events: TestEventBus): string[] {
	return events.emitted
		.filter((event) => event.channel === "goal_continuation_timer_state")
		.map((event) => {
			const data = event.data as { armed: boolean; kind: string };
			return `${data.armed ? "armed" : "fired"}:${data.kind}`;
		});
}

function createHarness() {
	const harness = createSentMessageHarness();
	const events = new TestEventBus();
	const entries: { customType: string; data: unknown }[] = [];
	const pi = {
		sendMessage: harness.sendMessage,
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		events,
	} as unknown as ExtensionAPI;
	return { monitor: new MonitorAwareGoalContinuation(pi), harness, events, entries };
}

/** A delivered monitor event (a log line, not a person's words), the input of a monitor-event turn. */
function monitorEvent(index: number): AgentMessage {
	return {
		role: "custom",
		customType: MONITOR_NOTIFICATION_CUSTOM_TYPE,
		content: `<system-reminder>Monitor event(build): step ${index} still running</system-reminder>`,
		display: false,
		details: { monitors: [{ id: "bash_1", description: "build", eventCount: 1, kinds: ["line"] }] },
		timestamp: index,
	} as AgentMessage;
}

async function setWakeSources(events: TestEventBus, activeCount: number): Promise<void> {
	events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount });
	await events.flush();
}

function isPaused(goal: Goal | null): boolean {
	return goal?.status !== "active" || goal.continuationStoppedAt !== undefined;
}

function idleTurns(count: number): AgentMessage[][] {
	return Array.from({ length: count }, (_, index) => [reply(IDLE_REPLIES[index % IDLE_REPLIES.length] ?? "")]);
}

async function runTurns(
	monitor: MonitorAwareGoalContinuation,
	ctx: ExtensionContext,
	goal: Goal,
	turns: readonly (readonly AgentMessage[])[],
): Promise<Goal | null> {
	let current: Goal | null = goal;
	for (const messages of turns) {
		if (current?.status !== "active" || current.continuationStoppedAt !== undefined) break;
		current = await monitor.afterAgentEnd({ ctx, goal: current, messages });
	}
	return current;
}

describe("issue #5160: reworded idle replies and live wake sources", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("trips the repetition guard on reworded tool-less replies once the stall check is answered idle", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-reworded");
		const { monitor, harness, events } = createHarness();
		const goal = activeGoal("goal-issue-5160-reworded");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		const turns = Array.from({ length: IDLE_REPLY_STREAK }, (_, index) => [
			reply(IDLE_REPLIES[index % IDLE_REPLIES.length] ?? ""),
		]);
		await runTurns(monitor, ctx, goal, turns);

		expect(harness.sent).toHaveLength(IDLE_REPLY_STREAK - 1);
		expect(harness.sent.some((sent) => sent.message.content.includes("<goal_stall_check>"))).toBe(true);
		expect(Reflect.get(continuation, "GOAL_IDLE_REPLY_STREAK")).toBe(IDLE_REPLY_STREAK);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			continuationStoppedAt: expect.any(Number),
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "idle" }),
		});
	});

	it("still trips when the idle replies are broken only by a re-check whose answer never changes", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-recheck");
		const { monitor, harness } = createHarness();
		const goal = activeGoal("goal-issue-5160-recheck");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		const turns: AgentMessage[][] = [];
		for (let cycle = 1; cycle <= 6; cycle++) {
			turns.push(...IDLE_REPLIES.slice(0, 3).map((text) => [reply(text)]), recheckTurn(cycle));
		}
		await runTurns(monitor, ctx, goal, turns);

		expect(harness.sent.length).toBeLessThan(turns.length);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "active",
			continuationStoppedAt: expect.any(Number),
		});
	});

	it("pauses the goal resumably with an idle reason, and the next user turn resumes it", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-resumable");
		const { monitor, harness, entries } = createHarness();
		const goal = activeGoal("goal-issue-5160-resumable");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		await runTurns(monitor, ctx, goal, idleTurns(IDLE_REPLY_STREAK));
		const paused = await readGoal(goalStoreRef(ctx));
		expect(paused).toMatchObject({ status: "active", continuationStoppedAt: expect.any(Number) });
		expect(paused?.blockedReason).toBeUndefined();
		expect(entries).toContainEqual({
			customType: "goal-continuation-stopped",
			data: expect.objectContaining({ goalId: goal.id, reason: "idle" }),
		});

		const sentBeforeResume = harness.sent.length;
		// What an accepted direct message does (DirectInputLifecycle.onDisposition), then the user's own turn.
		const reset = await resetContinuationStreak(goalStoreRef(ctx), { unattended: true });
		if (reset === null) throw new Error("Expected the paused goal to persist");
		monitor.noteUserPrompt();
		await monitor.afterAgentEnd({ ctx, goal: reset, messages: [reply("Back on it.")] });
		const resumedDelivery = waitForSentCount(harness, sentBeforeResume + 1);
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS);
		await resumedDelivery;

		expect(harness.sent).toHaveLength(sentBeforeResume + 1);
		const resumed = await readGoal(goalStoreRef(ctx));
		expect(resumed).toMatchObject({ status: "active" });
		expect(resumed?.continuationStoppedAt).toBeUndefined();
	});

	it("resets the idle streak on the session's first new tool effect", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-first-tool");
		const { monitor, harness } = createHarness();
		const goal = activeGoal("goal-issue-5160-first-tool");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		const turns = [...idleTurns(IDLE_REPLY_STREAK - 1), progressTurn(1), ...idleTurns(1)];
		await runTurns(monitor, ctx, goal, turns);

		expect(harness.sent).toHaveLength(turns.length);
		const current = await readGoal(goalStoreRef(ctx));
		expect(current).toMatchObject({ status: "active" });
		expect(current?.continuationStoppedAt).toBeUndefined();
	});

	it("keeps continuing while tool-using turns interleave with idle replies", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-progress");
		const { monitor, harness } = createHarness();
		const goal = activeGoal("goal-issue-5160-progress");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		const turns: AgentMessage[][] = [];
		for (let cycle = 1; cycle <= 4; cycle++) {
			turns.push(progressTurn(cycle), ...IDLE_REPLIES.slice(0, 3).map((text) => [reply(text)]));
		}
		await runTurns(monitor, ctx, goal, turns);

		expect(harness.sent).toHaveLength(turns.length);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("does not pause a goal whose idle replies answered monitor wakes once the source drains", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-monitor-wait");
		const { monitor, harness, events } = createHarness();
		const ref = goalStoreRef(ctx);
		const goal = activeGoal("goal-issue-5160-monitor-wait");
		await writeGoal(ref, goal);
		monitor.start(ctx);
		await setWakeSources(events, 1);
		await monitor.afterAgentEnd({ ctx, goal, messages: [reply("Armed a monitor for the build.")] });

		// Ten tool-less replies while waiting: backstop wakes alternate with monitor-event turns.
		for (let wake = 0; wake < 10; wake++) {
			const text = IDLE_REPLIES[wake % IDLE_REPLIES.length] ?? "";
			if (wake % 2 === 0) {
				const backstop = waitForSentCount(harness, harness.sent.length + 1);
				await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
				await backstop;
			}
			monitor.noteContinuationStarted();
			const messages = wake % 2 === 0 ? [reply(text)] : [monitorEvent(wake), reply(text)];
			await monitor.afterAgentEnd({ ctx, goal: (await readGoal(ref)) as Goal, messages });
			expect(isPaused(await readGoal(ref))).toBe(false);
		}

		const drainFire = waitForSentCount(harness, harness.sent.length + 1);
		await setWakeSources(events, 0);
		await vi.advanceTimersByTimeAsync(1_000);
		await drainFire;
		monitor.noteContinuationStarted();
		const sentBeforeReply = harness.sent.length;
		const afterDrain = [[reply("The build finished green; moving on to the release notes.")], ...idleTurns(7)];
		await runTurns(monitor, ctx, (await readGoal(ref)) as Goal, afterDrain);

		// The reply to the drain fire is not counted either, so 7 more idle replies still continue.
		expect(harness.sent).toHaveLength(sentBeforeReply + afterDrain.length);
		expect(isPaused(await readGoal(ref))).toBe(false);
	});

	it("holds the idle count on a reply to a monitor event", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-monitor-event");
		const { monitor, harness } = createHarness();
		const ref = goalStoreRef(ctx);
		const goal = activeGoal("goal-issue-5160-monitor-event");
		await writeGoal(ref, goal);
		monitor.start(ctx);

		await runTurns(monitor, ctx, goal, idleTurns(IDLE_REPLY_STREAK - 1));
		const eventTurn = [monitorEvent(1), reply("The build log moved on; nothing to do yet.")];
		await runTurns(monitor, ctx, (await readGoal(ref)) as Goal, [eventTurn]);
		expect(harness.sent).toHaveLength(IDLE_REPLY_STREAK);
		expect(isPaused(await readGoal(ref))).toBe(false);

		// Held, not reset: the next idle reply is the eighth that counts.
		await runTurns(monitor, ctx, (await readGoal(ref)) as Goal, idleTurns(1));
		expect(harness.sent).toHaveLength(IDLE_REPLY_STREAK);
		expect(await readGoal(ref)).toMatchObject({ status: "active", continuationStoppedAt: expect.any(Number) });
	});

	it("starts the idle count over when a wait's wake sources drain", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-drain-reset");
		const { monitor, harness, events } = createHarness();
		const ref = goalStoreRef(ctx);
		const goal = activeGoal("goal-issue-5160-drain-reset");
		await writeGoal(ref, goal);
		monitor.start(ctx);

		await runTurns(monitor, ctx, goal, idleTurns(IDLE_REPLY_STREAK - 1));
		await setWakeSources(events, 1);
		await runTurns(monitor, ctx, (await readGoal(ref)) as Goal, [[reply("Waiting on the deploy job.")]]);
		expect(monitor.scheduledContinuation()).toBe("monitor");

		const drainFire = waitForSentCount(harness, harness.sent.length + 1);
		await setWakeSources(events, 0);
		await vi.advanceTimersByTimeAsync(1_000);
		await drainFire;
		monitor.noteContinuationStarted();
		const sentBeforeReply = harness.sent.length;
		await runTurns(monitor, ctx, (await readGoal(ref)) as Goal, [[reply("The deploy finished.")]]);

		expect(harness.sent).toHaveLength(sentBeforeReply + 1);
		expect(isPaused(await readGoal(ref))).toBe(false);
	});

	it.each([
		["/goal resume", "command"],
		["a typed message", "message"],
	] as const)("gives a goal paused as idle a fresh idle count after %s", async (_label, resumeWith) => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, `issue-5160-resume-${resumeWith}`);
		const harness = createGoalHarness();
		const { tools, commands, handlers } = harness;
		const ref = goalStoreRef(ctx);
		await tools
			.get("create_goal")
			?.execute("c1", { objective: "Keep moving" }, undefined, undefined, ctx as ExtensionToolContext);
		const endTurn = async (text: string) => {
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [reply(text)] }, ctx);
		};
		for (let turn = 0; turn < IDLE_REPLY_STREAK; turn++) await endTurn(IDLE_REPLIES[turn % 4] ?? "");
		expect(await readGoal(ref)).toMatchObject({ status: "active", continuationStoppedAt: expect.any(Number) });

		const resumed = waitForSentCount(harness, harness.sent.length + 1);
		if (resumeWith === "command") {
			await commands.get("goal")?.handler("resume", ctx);
		} else {
			vi.useFakeTimers();
			const input = { inputId: "resume-message" };
			await runGoalHandlers(
				handlers,
				"input",
				{ type: "input", ...input, text: "go on", source: "interactive" },
				ctx,
			);
			await runGoalHandlers(
				handlers,
				"input_disposition",
				{ type: "input_disposition", ...input, disposition: "started" },
				ctx,
			);
			await endTurn("On it.");
			await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS);
		}
		await resumed;

		const sentBeforeReply = harness.sent.length;
		await endTurn("Picking the work back up.");
		expect(harness.sent).toHaveLength(sentBeforeReply + 1);
		expect(isPaused(await readGoal(ref))).toBe(false);
	});

	it("parks a user-grace continuation on a live wake source and resumes when it drains", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-grace-parks");
		const { monitor, harness, events } = createHarness();
		const goal = activeGoal("goal-issue-5160-grace-parks");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 1 });
		await events.flush();

		monitor.noteUserPrompt();
		await monitor.afterAgentEnd({ ctx, goal, messages: [reply("Armed a monitor for the build.")] });
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS * 3);

		// No grace timer was ever armed, so no admission (and no in-flight delivery) can exist.
		expect(timerStates(events)).toEqual(["armed:monitor"]);
		expect(monitor.scheduledContinuation()).toBe("monitor");
		expect(harness.sent).toHaveLength(0);

		const resumed = waitForSentCount(harness, 1);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 0 });
		await events.flush();
		await vi.advanceTimersByTimeAsync(1_000);
		await resumed;

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("parks a grace timer that a wake source outlived when it was armed during the grace", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-5160-grace-armed-late");
		const { monitor, harness, events } = createHarness();
		const goal = activeGoal("goal-issue-5160-grace-armed-late");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		monitor.noteUserPrompt();
		await monitor.afterAgentEnd({ ctx, goal, messages: [reply("Started the background build.")] });
		expect(monitor.scheduledContinuation()).toBe("userGrace");
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-background-sessions", activeCount: 1 });
		await events.flush();
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS);

		// The grace fired and re-parked synchronously, before any admission I/O could start a delivery.
		expect(timerStates(events)).toEqual(["armed:userGrace", "fired:userGrace", "armed:monitor"]);
		expect(monitor.scheduledContinuation()).toBe("monitor");
		expect(harness.sent).toHaveLength(0);

		const backstop = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
		await backstop;
		expect(harness.sent).toHaveLength(1);
	});
});
