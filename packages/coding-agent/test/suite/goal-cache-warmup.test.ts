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
	waitForEventCount,
	waitForSentCount,
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

async function setupWarmHarness(
	threadId: string,
): Promise<{ harness: GoalHarness; notices: string[]; ctx: Awaited<ReturnType<typeof makeGoalContext>> }> {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId, {
		pendingMessages: false,
		model: cacheModel(),
		cacheSafeWaitSeconds: 270,
	});
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
	return { harness, notices, ctx };
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

		expect(notices).toEqual([]);

		expect(channelEvents(harness, "goal_continuation_scheduled")).toEqual([
			expect.objectContaining({
				goalId: expect.any(String),
				delayMs: 270_000,
				iteration: 1,
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
				delayMs: 270_000,
				iteration: 1,
				activeMonitorCount: 1,
				cache: expect.objectContaining({ cachedTokens: 120_000, ttlSeconds: 300 }),
			}),
		);
	});

	it("celebrates the cache-warm wake when the deferred continuation fires", async () => {
		vi.useFakeTimers();
		const { harness, notices } = await setupWarmHarness("thread-cache-warm-resumed");

		const delayedDeliveryRecorded = waitForSentCount(harness, 1);
		const resumedEventRecorded = waitForEventCount(harness.events, "goal_continuation_resumed", 1);
		await vi.advanceTimersByTimeAsync(270_000);
		await Promise.all([delayedDeliveryRecorded, resumedEventRecorded]);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");

		expect(channelEvents(harness, "goal_continuation_resumed")).toEqual([
			expect.objectContaining({
				goalId: expect.any(String),
				delayMs: 270_000,
				waitedMs: 270_000,
				iteration: 1,
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
				waitedMs: 270_000,
				iteration: 1,
				activeMonitorCount: 1,
				cache: expect.objectContaining({ cachedTokens: 120_000 }),
			}),
		);

		expect(notices).toEqual([]);
	});

	it("increments accepted monitor schedules and resets after the wake epoch drains", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await setupWarmHarness("thread-cache-warm-iterations");

		for (let iteration = 1; iteration <= 2; iteration++) {
			const delivered = waitForSentCount(harness, iteration);
			const resumed = waitForEventCount(harness.events, "goal_continuation_resumed", iteration);
			await vi.advanceTimersByTimeAsync(270_000);
			await Promise.all([delivered, resumed]);
			if (iteration < 2) {
				await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
				await runGoalHandlers(
					harness.handlers,
					"agent_end",
					{ type: "agent_end", messages: [cleanAssistantStop()] },
					ctx,
				);
			}
		}

		expect(warmupEntryData(harness).map(({ phase, iteration }) => ({ phase, iteration }))).toEqual([
			{ phase: "scheduled", iteration: 1 },
			{ phase: "resumed", iteration: 1 },
			{ phase: "scheduled", iteration: 2 },
			{ phase: "resumed", iteration: 2 },
		]);

		harness.events.emit("terminal_monitor_state", { activeCount: 0 });
		await harness.events.flush();
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);

		expect(warmupEntryData(harness).at(-1)).toEqual(expect.objectContaining({ phase: "scheduled", iteration: 1 }));
	});

	it("resets the warm iteration after an accepted user prompt", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await setupWarmHarness("thread-cache-warm-user-reset");
		const firstResumed = waitForEventCount(harness.events, "goal_continuation_resumed", 1);
		await vi.advanceTimersByTimeAsync(270_000);
		await firstResumed;

		await runGoalHandlers(
			harness.handlers,
			"input",
			{ type: "input", inputId: "reset-iteration", text: "new direction", source: "interactive" },
			ctx,
		);
		await runGoalHandlers(
			harness.handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "reset-iteration", disposition: "started" },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);
		await vi.advanceTimersByTimeAsync(10_000);
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);

		expect(warmupEntryData(harness).at(-1)).toEqual(expect.objectContaining({ phase: "scheduled", iteration: 1 }));
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

		expect(notices).toEqual([]);

		const scheduled = warmupEntryData(harness);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toEqual(expect.objectContaining({ phase: "scheduled" }));
		expect(scheduled[0]?.cache).toBeUndefined();
	});
});
