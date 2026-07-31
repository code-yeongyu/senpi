import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorAwareGoalContinuation } from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	makeGoalContext,
	TestEventBus,
} from "../goal-monitor-test-harness.ts";

const REPEATED_STATUS_LINE = "WORKING: waiting for CI; ending the turn.";

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

function assistantStopWithText(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected an assistant stop message");
	return { ...message, content: [{ type: "text", text }] };
}

function toolUsingTurnWithText(text: string, turn: number): AgentMessage[] {
	const finalAssistant = assistantStopWithText(text);
	if (finalAssistant.role !== "assistant") throw new Error("Expected an assistant stop message");
	const toolCallId = `issue-566-tool-${turn}`;
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

function createMonitorHarness(): {
	monitor: MonitorAwareGoalContinuation;
	sent: string[];
	events: TestEventBus;
} {
	const sent: string[] = [];
	const events = new TestEventBus();
	const pi = {
		sendMessage: (message: { readonly content: string }) => sent.push(message.content),
		events,
	} as unknown as ExtensionAPI;
	return { monitor: new MonitorAwareGoalContinuation(pi), sent, events };
}

async function runTurns(
	monitor: MonitorAwareGoalContinuation,
	ctx: ExtensionContext,
	goal: Goal,
	turns: readonly (readonly AgentMessage[])[],
): Promise<void> {
	let current: Goal | null = goal;
	for (const messages of turns) {
		if (current === null) throw new Error("Expected the goal to survive the turn");
		current = await monitor.afterAgentEnd({ ctx, goal: current, messages });
	}
}

describe("issue #566: repetition guard must not block tool-using turns", () => {
	afterEach(async () => {
		await cleanupGoalMonitorTempDirs();
	});

	it("keeps the goal active when every turn uses tools despite identical final text", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-566-tool-turns");
		const { monitor } = createMonitorHarness();
		const goal = activeGoal("goal-issue-566-tool-turns");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		await runTurns(
			monitor,
			ctx,
			goal,
			[1, 2, 3, 4].map((turn) => toolUsingTurnWithText(REPEATED_STATUS_LINE, turn)),
		);

		expect(notices).not.toContainEqual(expect.stringContaining("repeated assistant output"));
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("still blocks after three consecutive toolless identical outputs", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-566-toolless-loop");
		const { monitor, events } = createMonitorHarness();
		const goal = activeGoal("goal-issue-566-toolless-loop");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		await runTurns(monitor, ctx, goal, [
			[assistantStopWithText(REPEATED_STATUS_LINE)],
			[assistantStopWithText(REPEATED_STATUS_LINE)],
			[assistantStopWithText(REPEATED_STATUS_LINE)],
		]);

		expect(notices).toContainEqual(expect.stringContaining("repeated assistant output"));
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "repeated assistant output",
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "repetition" }),
		});
	});

	it("clears the repetition window when a tool-using turn interrupts the streak", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "issue-566-interrupted-streak");
		const { monitor } = createMonitorHarness();
		const goal = activeGoal("goal-issue-566-interrupted-streak");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		await runTurns(monitor, ctx, goal, [
			[assistantStopWithText(REPEATED_STATUS_LINE)],
			[assistantStopWithText(REPEATED_STATUS_LINE)],
			toolUsingTurnWithText(REPEATED_STATUS_LINE, 3),
			[assistantStopWithText(REPEATED_STATUS_LINE)],
			[assistantStopWithText(REPEATED_STATUS_LINE)],
		]);

		expect(notices).not.toContainEqual(expect.stringContaining("repeated assistant output"));
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});
});
