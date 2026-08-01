import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalContextState,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "./goal-monitor-test-harness.ts";

interface ActiveMonitorHarness {
	readonly harness: GoalHarness;
	readonly ctx: ExtensionContext;
	readonly notices: string[];
	readonly state: GoalContextState;
}

async function createActiveMonitorHarness(threadId: string): Promise<ActiveMonitorHarness> {
	const notices: string[] = [];
	const state: GoalContextState = { pendingMessages: false };
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId, state);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep monitoring" }, undefined, undefined, ctx);
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	harness.events.emit("terminal_monitor_state", { activeCount: 1 });
	await harness.events.flush();
	return { harness, ctx, notices, state };
}

async function endCleanTurn(harness: GoalHarness, ctx: ExtensionContext): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);
}

describe("goal monitor continuation lifecycle", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("keeps only one delayed continuation across repeated clean turns", async () => {
		vi.useFakeTimers();
		const { harness, ctx, notices } = await createActiveMonitorHarness("thread-monitor-dedupe");

		await endCleanTurn(harness, ctx);
		await endCleanTurn(harness, ctx);

		expect(harness.sent).toHaveLength(0);
		expect(notices).toHaveLength(1);
		const delayedDeliveryRecorded = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(240_000);
		await delayedDeliveryRecorded;
		expect(harness.sent).toHaveLength(1);
	});

	it("cancels the delayed continuation when the final monitor settles", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createActiveMonitorHarness("thread-monitor-settles");
		await endCleanTurn(harness, ctx);
		expect(harness.sent).toHaveLength(0);

		harness.events.emit("terminal_monitor_state", { activeCount: 0 });
		await harness.events.flush();

		expect(harness.sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(harness.sent).toHaveLength(0);
	});

	it("suppresses the delayed continuation when the goal stops or messages become pending", async () => {
		vi.useFakeTimers();
		const completed = await createActiveMonitorHarness("thread-goal-completes");
		await endCleanTurn(completed.harness, completed.ctx);
		await completed.harness.tools
			.get("update_goal")
			?.execute("complete", { status: "complete" }, undefined, undefined, completed.ctx);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(completed.harness.sent).toHaveLength(0);

		const pending = await createActiveMonitorHarness("thread-pending-message");
		await endCleanTurn(pending.harness, pending.ctx);
		pending.state.pendingMessages = true;
		await vi.advanceTimersByTimeAsync(240_000);
		expect(pending.harness.sent).toHaveLength(0);
	});

	it("disposes the delayed continuation on session shutdown", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createActiveMonitorHarness("thread-monitor-shutdown");
		await endCleanTurn(harness, ctx);

		await runGoalHandlers(harness.handlers, "session_shutdown", { type: "session_shutdown" }, ctx);
		await vi.advanceTimersByTimeAsync(240_000);

		expect(harness.sent).toHaveLength(0);
	});

	it("disposes the delayed continuation on session reload", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createActiveMonitorHarness("thread-monitor-reload");
		const baselineTimerCount = vi.getTimerCount();
		await endCleanTurn(harness, ctx);
		expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		expect(vi.getTimerCount()).toBe(baselineTimerCount);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(harness.sent).toHaveLength(0);
	});
});
