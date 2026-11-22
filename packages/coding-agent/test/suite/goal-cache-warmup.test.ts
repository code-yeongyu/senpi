import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	type GoalCacheWarmupEntryData,
} from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
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
const BACKSTOP_DELAY_MS = GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS;

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

function deepseekModel(): Model<Api> {
	return {
		...cacheModel(),
		id: "deepseek-v4-pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
	} as Model<Api>;
}

function gpt6Model(): Model<Api> {
	return {
		...cacheModel(),
		id: "gpt-6-luna",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
	} as Model<Api>;
}

async function setupWarmHarness(
	threadId: string,
	options: { readonly model?: Model<Api>; readonly goalBackstopMaxSeconds?: number } = {},
): Promise<{ harness: GoalHarness; notices: string[]; ctx: Awaited<ReturnType<typeof makeGoalContext>> }> {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId, {
		pendingMessages: false,
		model: options.model ?? cacheModel(),
		cacheSafeWaitSeconds: 270,
		...(options.goalBackstopMaxSeconds !== undefined
			? { goalBackstopMaxSeconds: options.goalBackstopMaxSeconds }
			: {}),
	});
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx as ExtensionToolContext);
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
		vi.setSystemTime(0);
		const { harness, notices } = await setupWarmHarness("thread-cache-warm-scheduled");

		expect(notices).toEqual([]);

		expect(channelEvents(harness, "goal_continuation_scheduled")).toEqual([
			expect.objectContaining({
				goalId: expect.any(String),
				delayMs: BACKSTOP_DELAY_MS,
				dueAtMs: BACKSTOP_DELAY_MS,
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
				delayMs: BACKSTOP_DELAY_MS,
				dueAtMs: BACKSTOP_DELAY_MS,
				iteration: 1,
				activeMonitorCount: 1,
				cache: expect.objectContaining({ cachedTokens: 120_000, ttlSeconds: 300 }),
			}),
		);
	});

	// code-yeongyu/senpi#831: direct DeepSeek has no cache TTL, so the default wait is the long liveness re-check.
	it("does not arm a 270s cache-preservation wake for DeepSeek's best-effort cache", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { harness } = await setupWarmHarness("thread-cache-best-effort", { model: deepseekModel() });

		expect(channelEvents(harness, "goal_continuation_scheduled")).toEqual([
			expect.objectContaining({
				delayMs: 3_570_000,
				cache: { cachedTokens: 120_000, cacheLifetime: "best-effort" },
			}),
		]);

		await vi.advanceTimersByTimeAsync(BACKSTOP_DELAY_MS);
		expect(harness.sent).toHaveLength(0);
	});

	it("honors an explicit backstop on a best-effort lane", async () => {
		vi.useFakeTimers();
		const { harness } = await setupWarmHarness("thread-cache-best-effort-configured", {
			model: deepseekModel(),
			goalBackstopMaxSeconds: 900,
		});

		expect(channelEvents(harness, "goal_continuation_scheduled")).toEqual([
			expect.objectContaining({ delayMs: 900_000 }),
		]);
	});

	// code-yeongyu/senpi#2090: GPT-6 reports its 30-minute TTL; the liveness backstop stays the configured default.
	it("reports the 30-minute GPT-6 TTL while keeping the default backstop", async () => {
		vi.useFakeTimers();
		const { harness } = await setupWarmHarness("thread-cache-gpt6", { model: gpt6Model() });

		expect(channelEvents(harness, "goal_continuation_scheduled")).toEqual([
			expect.objectContaining({
				delayMs: BACKSTOP_DELAY_MS,
				cache: expect.objectContaining({ cachedTokens: 120_000, ttlSeconds: 1800 }),
			}),
		]);
	});

	it("records a timer wake when the deferred continuation fires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { harness, notices } = await setupWarmHarness("thread-cache-warm-resumed");

		const delayedDeliveryRecorded = waitForSentCount(harness, 1);
		const resumedEventRecorded = waitForEventCount(harness.events, "goal_continuation_resumed", 1);
		await vi.advanceTimersByTimeAsync(BACKSTOP_DELAY_MS);
		await Promise.all([delayedDeliveryRecorded, resumedEventRecorded]);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");

		expect(channelEvents(harness, "goal_continuation_resumed")).toEqual([
			expect.objectContaining({
				goalId: expect.any(String),
				delayMs: BACKSTOP_DELAY_MS,
				waitedMs: BACKSTOP_DELAY_MS,
				dueAtMs: BACKSTOP_DELAY_MS,
				wakeCause: "timer",
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
				waitedMs: BACKSTOP_DELAY_MS,
				dueAtMs: BACKSTOP_DELAY_MS,
				wakeCause: "timer",
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
			await vi.advanceTimersByTimeAsync(BACKSTOP_DELAY_MS);
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
		await vi.advanceTimersByTimeAsync(BACKSTOP_DELAY_MS);
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
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		await harness.tools
			.get("create_goal")
			?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx as ExtensionToolContext);
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
