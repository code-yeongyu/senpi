import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { GoalWaitTicker } from "../../../src/core/extensions/builtin/goal/wait-ticker.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createSentMessageHarness,
	makeGoalContext,
	type SentMessageHarness,
	TestEventBus,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const STALL_CHECK = "<goal_stall_check>";

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

type LiveWait = {
	readonly messages: SentMessageHarness;
	readonly events: TestEventBus;
	/** End one toolless turn while the channel stays live and wait for the backstop continuation it schedules. */
	readonly waitingTurn: (label: string) => Promise<string>;
};

async function startLiveWait(id: string, activeCount: number): Promise<LiveWait> {
	const notices: string[] = [];
	const ctx = await makeGoalContext(notices, `thread-${id}`);
	const messages = createSentMessageHarness();
	const events = new TestEventBus();
	const ticker = new GoalWaitTicker({ render: (renderCtx, text) => renderCtx.ui.setStatus("goal-wait", text) });
	const pi = { sendMessage: messages.sendMessage, events, appendEntry: () => {} } as unknown as ExtensionAPI;
	const monitor = new MonitorAwareGoalContinuation(
		pi,
		() => false,
		() => {},
		ticker,
	);
	const goal = activeGoal(`goal-${id}`);
	await writeGoal(
		{
			baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
			threadId: ctx.sessionManager.getSessionId(),
		},
		goal,
	);
	monitor.start(ctx);
	events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount });
	await events.flush();

	const waitingTurn = async (label: string): Promise<string> => {
		const stop = cleanAssistantStop();
		if (stop.role !== "assistant") throw new Error("cleanAssistantStop() must return an assistant message");
		await monitor.afterAgentEnd({ ctx, goal, messages: [{ ...stop, content: [{ type: "text", text: label }] }] });
		const next = waitForSentCount(messages, messages.sent.length + 1);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS);
		await next;
		return messages.sent[messages.sent.length - 1]?.message.content ?? "";
	};
	return { messages, events, waitingTurn };
}

describe("goal live channel dead-wait bound (senpi#4265)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("a permanently live channel still surfaces a stall check after the higher bound", async () => {
		vi.useFakeTimers();
		const { waitingTurn } = await startLiveWait("dead-bound", 1);

		const continuations: string[] = [];
		for (let i = 0; i < 4; i++) continuations.push(await waitingTurn(`waiting turn ${i}`));

		expect(continuations.slice(0, 3).some((content) => content.includes(STALL_CHECK))).toBe(false);
		expect(continuations[3]).toContain(STALL_CHECK);
	});

	it("a never-delivering live channel does not trip the ordinary 3-turn toolless bound", async () => {
		vi.useFakeTimers();
		const { waitingTurn } = await startLiveWait("live-3", 1);

		const continuations: string[] = [];
		for (let i = 0; i < 3; i++) continuations.push(await waitingTurn(`waiting turn ${i}`));

		expect(continuations.some((content) => content.includes(STALL_CHECK))).toBe(false);
	});

	it("a channel that delivers re-bases the live-wait counter instead of stalling a healthy wait", async () => {
		vi.useFakeTimers();
		const { events, waitingTurn } = await startLiveWait("delivers", 2);

		const continuations: string[] = [];
		for (let i = 0; i < 3; i++) continuations.push(await waitingTurn(`before delivery ${i}`));
		// One of the two children reports back: the channel delivered but stays live.
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });
		await events.flush();
		// Without the re-base this fourth live-wait turn would hit the dead-channel bound.
		continuations.push(await waitingTurn("after delivery 0"));
		expect(continuations.some((content) => content.includes(STALL_CHECK))).toBe(false);

		// The bound itself still holds: the counter restarted, it was not disabled.
		const afterDelivery: string[] = [];
		for (let i = 1; i < 4; i++) afterDelivery.push(await waitingTurn(`after delivery ${i}`));
		expect(afterDelivery.slice(0, 2).some((content) => content.includes(STALL_CHECK))).toBe(false);
		expect(afterDelivery[2]).toContain(STALL_CHECK);
	});
});
