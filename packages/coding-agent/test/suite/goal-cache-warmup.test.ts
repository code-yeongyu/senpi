import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalCacheWarmupEntryData } from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import {
	type AppendedGoalEntry,
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

const ENTRY_TYPE = "goal-cache-warmup";

function cacheModel(): Model<Api> {
	return {
		id: "claude-cache-warm",
		name: "Claude Cache Warm",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://gateway.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<Api>;
}

async function setupWarmHarness(threadId: string): Promise<{ harness: GoalHarness; notices: string[] }> {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId, { pendingMessages: false, model: cacheModel() });
	await harness.tools.get("create_goal")?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	harness.events.emit("terminal_monitor_state", { activeCount: 1 });
	await harness.events.flush();
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(
		harness.handlers,
		"agent_end",
		{ type: "agent_end", messages: [cleanAssistantStop({ cacheRead: 100_000, cacheWrite: 20_000 })] },
		ctx,
	);
	return { harness, notices };
}

function warmupEntryData(harness: GoalHarness): GoalCacheWarmupEntryData[] {
	return harness.entries
		.filter((entry: AppendedGoalEntry) => entry.customType === ENTRY_TYPE)
		.map((entry) => entry.data as GoalCacheWarmupEntryData);
}

function channelEvents(harness: GoalHarness, channel: string): unknown[] {
	return harness.events.emitted.filter((event) => event.channel === channel).map((event) => event.data);
}

describe("goal cache-warm continuation story", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("tells the cache-warm story when the continuation is scheduled", async () => {
		vi.useFakeTimers();
		const { harness, notices } = await setupWarmHarness("thread-cache-warm-scheduled");

		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/4 minutes/i);
		expect(notices[0]).toContain("~120K tokens");

		expect(channelEvents(harness, "goal_continuation_scheduled")).toEqual([
			expect.objectContaining({
				goalId: expect.any(String),
				delayMs: 240_000,
				activeMonitorCount: 1,
				cache: expect.objectContaining({ cachedTokens: 120_000, ttlSeconds: 300 }),
			}),
		]);

		const scheduled = warmupEntryData(harness);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toEqual(
			expect.objectContaining({
				phase: "scheduled",
				goalId: expect.any(String),
				delayMs: 240_000,
				activeMonitorCount: 1,
				cache: expect.objectContaining({ cachedTokens: 120_000, ttlSeconds: 300 }),
			}),
		);
	});

	it("celebrates the cache-warm wake when the deferred continuation fires", async () => {
		vi.useFakeTimers();
		const { harness, notices } = await setupWarmHarness("thread-cache-warm-resumed");

		const resumedEvent = harness.events.waitFor("goal_continuation_resumed");
		await vi.advanceTimersByTimeAsync(240_000);
		await resumedEvent;

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");

		expect(channelEvents(harness, "goal_continuation_resumed")).toEqual([
			expect.objectContaining({
				goalId: expect.any(String),
				delayMs: 240_000,
				waitedMs: 240_000,
				activeMonitorCount: 1,
				cache: expect.objectContaining({
					cachedTokens: 120_000,
					ttlSeconds: 300,
					estimatedSavedUsd: expect.closeTo(0.324, 5),
				}),
			}),
		]);

		const resumed = warmupEntryData(harness).filter((data) => data.phase === "resumed");
		expect(resumed).toHaveLength(1);
		expect(resumed[0]).toEqual(
			expect.objectContaining({
				phase: "resumed",
				waitedMs: 240_000,
				activeMonitorCount: 1,
				cache: expect.objectContaining({ cachedTokens: 120_000 }),
			}),
		);

		expect(notices.some((notice) => /cache-warm wake/i.test(notice) && notice.includes("$0.324"))).toBe(true);
	});

	it("keeps a plain explanation when no cache context exists", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-cache-warm-plain");
		await harness.tools
			.get("create_goal")
			?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);

		expect(notices[0]).toMatch(/4 minutes/i);
		expect(notices[0]).not.toContain("tokens");

		const scheduled = warmupEntryData(harness);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toEqual(expect.objectContaining({ phase: "scheduled" }));
		expect(scheduled[0]?.cache).toBeUndefined();
	});
});
