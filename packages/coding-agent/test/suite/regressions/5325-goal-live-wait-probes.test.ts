import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { GOAL_CONTINUATION_CAP } from "../../../src/core/extensions/builtin/goal/continuation.ts";
import { goalLiveElapsedSeconds } from "../../../src/core/extensions/builtin/goal/elapsed-ticker.ts";
import { readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createSentMessageHarness,
	makeGoalContext,
	TestEventBus,
	waitForEventCount,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

// #5325: a goal waiting on a live child (or monitor) answers each backstop re-check the same way,
// because nothing changed. Those unchanged answers tripped the cap/repetition guards and BLOCKED
// the goal while the child was still running; the child's later delivery turns then did real work
// against a blocked goal (timer stopped) until a user message reactivated it.

function storeRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function activeGoal(id: string): Goal {
	return {
		id,
		threadId: `${id}-thread`,
		objective: "Ship it",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function replyWithText(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("expected an assistant stop");
	return { ...message, content: [{ type: "text", text }] };
}

function childResultWorkTurn(): AgentMessage[] {
	const final = replyWithText("Child finished; applied its patch.");
	if (final.role !== "assistant") throw new Error("expected an assistant stop");
	return [
		{
			...final,
			content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts", newText: "x" } }],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			content: [{ type: "text", text: "edited a.ts" }],
			isError: false,
			timestamp: final.timestamp,
		},
		final,
	];
}

async function setup(thread: string, liveSource: string | undefined) {
	const ctx = await makeGoalContext([], thread);
	const harness = createSentMessageHarness();
	const events = new TestEventBus();
	const pi = { sendMessage: harness.sendMessage, events, appendEntry: () => {} } as unknown as ExtensionAPI;
	const monitor = new MonitorAwareGoalContinuation(pi);
	await writeGoal(storeRef(ctx), activeGoal(`goal-${thread}`));
	monitor.start(ctx);
	if (liveSource !== undefined) {
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: liveSource, activeCount: 1 });
		await events.flush();
	}
	const endTurn = async (messages: AgentMessage[]) => {
		const goal = await readGoal(storeRef(ctx));
		return monitor.afterAgentEnd({ ctx, goal, messages });
	};
	return { ctx, harness, events, monitor, endTurn };
}

describe("#5325 backstop re-checks while a resumption channel is live", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it.each([
		["a live child, unchanged empty replies (continuation cap)", "senpi-task", () => cleanAssistantStop()],
		[
			"a live child, the same 'still waiting' reply (repetition guard)",
			"senpi-task",
			() => replyWithText("Still waiting on the child."),
		],
		["a live monitor, unchanged empty replies (continuation cap)", "terminal-monitors", () => cleanAssistantStop()],
		[
			"a live monitor, the same 'still waiting' reply (repetition guard)",
			"terminal-monitors",
			() => replyWithText("Still waiting on the monitor."),
		],
	])("keeps the goal pursuing through %s, then works on the delivery", async (label, source, reply) => {
		vi.useFakeTimers();
		const { ctx, harness, events, monitor, endTurn } = await setup(`live-${label.replace(/\W+/g, "-")}`, source);

		// Re-checks run until the guards stop probing; none of them may block the goal.
		for (let fire = 1; fire <= GOAL_CONTINUATION_CAP + 2; fire++) {
			await endTurn([reply()]);
			const before = harness.sent.length;
			const fired = await monitor.fireNow();
			const goal = await readGoal(storeRef(ctx));
			expect(goal?.status).toBe("active");
			expect(goal?.continuationStoppedAt).toBeUndefined();
			if (!fired.fired || harness.sent.length === before) break;
		}
		const probes = harness.sent.length;
		const parked = await readGoal(storeRef(ctx));
		if (parked === null) throw new Error("goal missing");
		// The footer's live elapsed keeps counting for a parked goal; a stopped or blocked goal freezes it.
		expect(goalLiveElapsedSeconds(parked, 0, 5_000)).toBe(parked.timeUsedSeconds + 5);
		expect(probes).toBeLessThanOrEqual(GOAL_CONTINUATION_CAP);

		// Probing stopped: more time with the child still live queues no further hidden turns.
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS * 4);
		expect(harness.sent).toHaveLength(probes);

		// The child finishes; its delivery turn does real work and the goal keeps going on its own.
		events.emit(WAKE_SOURCE_STATE_EVENT, { source, activeCount: 0 });
		await events.flush();
		const next = waitForSentCount(harness, probes + 1);
		await endTurn(childResultWorkTurn());
		await next;
		const goal = await readGoal(storeRef(ctx));
		expect(goal?.status).toBe("active");
		expect(goal?.continuationStoppedAt).toBeUndefined();
	});

	it("counts again once the parked channel ends without delivering, so a dead channel cannot park forever", async () => {
		vi.useFakeTimers();
		const { ctx, harness, events, monitor, endTurn } = await setup("drained-silently", "senpi-task");
		for (let fire = 1; fire <= GOAL_CONTINUATION_CAP + 1; fire++) {
			await endTurn([cleanAssistantStop()]);
			const before = harness.sent.length;
			const fired = await monitor.fireNow();
			if (!fired.fired || harness.sent.length === before) break;
		}
		expect((await readGoal(storeRef(ctx)))?.status).toBe("active");

		const tripped = waitForEventCount(events, "goal_continuation_guard_tripped", 1);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 0 });
		await events.flush();
		await vi.advanceTimersByTimeAsync(1_000);
		await tripped;
		expect((await readGoal(storeRef(ctx)))?.status).toBe("blocked");
	});

	it("still blocks a genuinely idle goal that repeats itself with no channel live", async () => {
		vi.useFakeTimers();
		const { ctx, endTurn } = await setup("idle", undefined);
		for (let turn = 0; turn < 4; turn++) await endTurn([replyWithText("Nothing to do.")]);
		const goal = await readGoal(storeRef(ctx));
		expect(goal?.status).toBe("blocked");
	});
});
