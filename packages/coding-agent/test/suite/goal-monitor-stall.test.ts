import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal, resetContinuationStreak } from "../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForGoalContinuationCount,
} from "./goal-monitor-test-harness.ts";

const STALL_MARKER = "<goal_stall_check>";
const STALL_EVENT = "goal_monitor_continuation_stall";

interface StallHarness {
	readonly harness: GoalHarness;
	readonly ctx: ExtensionContext;
	readonly notices: string[];
}

async function createStallHarness(threadId: string, monitorsActive = true): Promise<StallHarness> {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep monitoring" }, undefined, undefined, ctx);
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	if (monitorsActive) {
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();
	}
	return { harness, ctx, notices };
}

function cleanAssistantStopWithText(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected an assistant message");
	return { ...message, content: [{ type: "text", text }] };
}

function toolUsingContinuationMessages(text: string): AgentMessage[] {
	const finalAssistant = cleanAssistantStopWithText(text);
	if (finalAssistant.role !== "assistant") throw new Error("Expected an assistant message");
	return [
		{
			...finalAssistant,
			content: [{ type: "toolCall", id: "stall-reset-tool", name: "bash", arguments: { command: "true" } }],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "stall-reset-tool",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: finalAssistant.timestamp,
		},
		finalAssistant,
	];
}

async function runContinuationCycle(
	harness: GoalHarness,
	ctx: ExtensionContext,
	messages: readonly AgentMessage[] = [cleanAssistantStop()],
): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [...messages] }, ctx);
}

async function runMonitorContinuationCycle(harness: GoalHarness, ctx: ExtensionContext): Promise<void> {
	await runContinuationCycle(harness, ctx);
	const ref = {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
	const goal = await readGoal(ref);
	if (goal === null) throw new Error("Expected persisted goal");
	const delayedDeliveryRecorded = waitForGoalContinuationCount(ctx, (goal.consecutiveContinuations ?? 0) + 1);
	await vi.advanceTimersByTimeAsync(240_000);
	await delayedDeliveryRecorded;
}

function stallEvents(harness: GoalHarness): unknown[] {
	return harness.events.emitted.filter((event) => event.channel === STALL_EVENT).map((event) => event.data);
}

describe("goal monitor continuation stall check", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("injects the stall check from the third consecutive monitor continuation onward", async () => {
		vi.useFakeTimers();
		const { harness, ctx, notices } = await createStallHarness("thread-stall-threshold");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(2);
		expect(harness.sent[0]?.message.content).not.toContain(STALL_MARKER);
		expect(harness.sent[1]?.message.content).not.toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(0);

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(3);
		expect(harness.sent[2]?.message.content).toContain(STALL_MARKER);
		expect(harness.sent[2]?.message.content).toContain("bash_output");
		expect(harness.sent[2]?.message.content).toContain("kill_bash");
		expect(stallEvents(harness)).toEqual([expect.objectContaining({ consecutiveContinuations: 3, toolless: true })]);
		expect(notices.some((notice) => /stall/i.test(notice))).toBe(true);

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent[3]?.message.content).toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(2);
	});

	it("injects the stall check from the third toolless immediate continuation", async () => {
		const { harness, ctx } = await createStallHarness("thread-stall-no-monitor", false);

		for (let turn = 1; turn <= 3; turn++) {
			await runContinuationCycle(harness, ctx, [cleanAssistantStopWithText(`toolless turn ${turn}`)]);
		}

		expect(harness.sent).toHaveLength(3);
		expect(harness.sent[0]?.message.content).not.toContain(STALL_MARKER);
		expect(harness.sent[1]?.message.content).not.toContain(STALL_MARKER);
		expect(harness.sent[2]?.message.content).toContain(STALL_MARKER);
		expect(harness.sent[2]?.message.content).not.toContain("bash_output");
		expect(stallEvents(harness)).toEqual([expect.objectContaining({ consecutiveContinuations: 3, toolless: true })]);
	});

	it("resets the toolless streak after a continuation turn uses tools", async () => {
		const { harness, ctx } = await createStallHarness("thread-stall-tool-reset", false);

		await runContinuationCycle(harness, ctx, [cleanAssistantStopWithText("toolless turn 1")]);
		await runContinuationCycle(harness, ctx, [cleanAssistantStopWithText("toolless turn 2")]);
		await runContinuationCycle(harness, ctx, toolUsingContinuationMessages("tool-ful turn"));
		await runContinuationCycle(harness, ctx, [cleanAssistantStopWithText("toolless turn 3")]);
		await runContinuationCycle(harness, ctx, [cleanAssistantStopWithText("toolless turn 4")]);

		expect(harness.sent).toHaveLength(5);
		for (const sent of harness.sent) {
			expect(sent.message.content).not.toContain(STALL_MARKER);
		}
		expect(stallEvents(harness)).toHaveLength(0);

		await runContinuationCycle(harness, ctx, [cleanAssistantStopWithText("toolless turn 5")]);
		expect(harness.sent[5]?.message.content).toContain(STALL_MARKER);
	});

	it("resets the streak when the monitors settle and a new monitor starts", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createStallHarness("thread-stall-settle-reset");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);

		harness.events.emit("terminal_monitor_state", { activeCount: 0 });
		await harness.events.flush();
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(3);
		expect(harness.sent[2]?.message.content).not.toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(0);
	});

	it("resets the streak when a real user prompt starts a turn", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createStallHarness("thread-stall-user-reset");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);
		await resetContinuationStreak({
			baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
			threadId: ctx.sessionManager.getSessionId(),
		});

		await runGoalHandlers(
			harness.handlers,
			"input",
			{ type: "input", inputId: "stall-reset", text: "continue", source: "interactive" },
			ctx,
		);
		await runGoalHandlers(
			harness.handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "stall-reset", disposition: "started" },
			ctx,
		);

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(3);
		expect(harness.sent[2]?.message.content).not.toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(0);
	});

	it("does not carry the streak across a completed goal into its replacement", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createStallHarness("thread-stall-goal-reset");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);

		await harness.tools.get("update_goal")?.execute("complete", { status: "complete" }, undefined, undefined, ctx);
		await harness.tools
			.get("create_goal")
			?.execute("create", { objective: "Fresh objective" }, undefined, undefined, ctx);

		const sentBefore = harness.sent.length;
		await runMonitorContinuationCycle(harness, ctx);
		const sentAfter = harness.sent.slice(sentBefore);
		expect(sentAfter.length).toBeGreaterThan(0);
		for (const sent of sentAfter) {
			expect(sent.message.content).not.toContain(STALL_MARKER);
		}
		expect(stallEvents(harness)).toHaveLength(0);
	});
});
