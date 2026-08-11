import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_CACHE_WARMUP_ENTRY_TYPE,
	type GoalCacheWarmupEntryData,
} from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import { GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import {
	type AppendedGoalEntry,
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "./goal-monitor-test-harness.ts";

describe("goal cache-warm rendering ownership", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("uses durable entries without duplicate transient notices", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const { tools, handlers, events, entries } = harness;
		const ctx = await makeGoalContext(notices, "thread-cache-warm-ownership");
		await tools.get("create_goal")?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);

		expect(notices).toEqual([]);
		expect(warmupPhases(entries)).toEqual([{ phase: "scheduled", iteration: 1 }]);

		const delivered = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_FALLBACK_DELAY_MS);
		await delivered;
		await vi.advanceTimersByTimeAsync(0);
		expect(notices).toEqual([]);
		expect(warmupPhases(entries)).toEqual([
			{ phase: "scheduled", iteration: 1 },
			{ phase: "resumed", iteration: 1 },
		]);
	});
});

function warmupPhases(
	entries: readonly AppendedGoalEntry[],
): Array<Pick<GoalCacheWarmupEntryData, "phase" | "iteration">> {
	return entries
		.filter((entry) => entry.customType === GOAL_CACHE_WARMUP_ENTRY_TYPE)
		.map((entry) => entry.data as GoalCacheWarmupEntryData | undefined)
		.filter((data): data is GoalCacheWarmupEntryData => data !== undefined)
		.map(({ phase, iteration }) => ({ phase, iteration }));
}
