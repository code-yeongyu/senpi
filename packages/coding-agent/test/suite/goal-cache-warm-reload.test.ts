import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	type GoalCacheWarmupEntryData,
} from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import { GOAL_CONTINUATION_SCHEDULED_EVENT } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForEventCount,
	waitForSentCount,
} from "./goal-monitor-test-harness.ts";

// Regression for #2051: a reload must not turn a parked wait into a new iteration-1 wait.
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

function warmupEntries(harness: GoalHarness): GoalCacheWarmupEntryData[] {
	return harness.entries
		.filter((entry) => entry.customType === ENTRY_TYPE)
		.map((entry) => entry.data as GoalCacheWarmupEntryData);
}

function branchContext(ctx: ExtensionContext, generations: readonly GoalHarness[]): ExtensionContext {
	const branch = () =>
		generations.flatMap((generation) =>
			generation.entries.map((entry, index) => ({
				type: "custom" as const,
				id: `entry-${index}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: entry.customType,
				data: entry.data,
			})),
		);
	return { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: branch } } as ExtensionContext;
}

async function endTurn(harness: GoalHarness, ctx: ExtensionContext, cacheRead = 0): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(
		harness.handlers,
		"agent_end",
		{ type: "agent_end", messages: [cleanAssistantStop({ cacheRead, cacheWrite: 20_000 })] },
		ctx,
	);
}

async function reloadInto(generations: GoalHarness[], ctx: ExtensionContext): Promise<GoalHarness> {
	const retired = generations.at(-1);
	if (retired !== undefined) {
		await runGoalHandlers(retired.handlers, "session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
	}
	const next = createGoalHarness();
	// The terminal builtin replays its monitor snapshot before goal session_start (builtin order).
	next.events.emit("terminal_monitor_state", { activeCount: 1 });
	await next.events.flush();
	await runGoalHandlers(next.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	generations.push(next);
	return next;
}

describe("goal cache-warm wait across reloads (#2051)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("restores the parked wait instead of appending a new iteration-1 wait", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const generations: GoalHarness[] = [];
		const base = await makeGoalContext([], "thread-cache-warm-reload", {
			pendingMessages: false,
			model: cacheModel(),
			cacheSafeWaitSeconds: 270,
		});
		const ctx = branchContext(base, generations);
		const first = createGoalHarness();
		generations.push(first);
		await runGoalHandlers(first.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await first.tools
			.get("create_goal")
			?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
		first.events.emit("terminal_monitor_state", { activeCount: 1 });
		await first.events.flush();
		await endTurn(first, ctx, 100_000);

		const woke = waitForSentCount(first, 1);
		await vi.advanceTimersByTimeAsync(BACKSTOP_DELAY_MS);
		await woke;
		await endTurn(first, ctx, 900_000);
		const parked = warmupEntries(first).at(-1);
		expect(parked).toEqual(expect.objectContaining({ phase: "scheduled", iteration: 2 }));

		await vi.advanceTimersByTimeAsync(60_000);
		const second = await reloadInto(generations, ctx);
		await vi.advanceTimersByTimeAsync(3_000);
		const third = await reloadInto(generations, ctx);

		expect(warmupEntries(second)).toEqual([]);
		expect(warmupEntries(third)).toEqual([]);
		const restored = third.events.emitted
			.filter((event) => event.channel === GOAL_CONTINUATION_SCHEDULED_EVENT)
			.map((event) => event.data as GoalCacheWarmupEntryData);
		expect(restored.at(-1)).toEqual(
			expect.objectContaining({
				iteration: 2,
				dueAtMs: parked?.dueAtMs,
				cache: expect.objectContaining({ cachedTokens: 920_000 }),
			}),
		);

		// The restored timer fires at the ORIGINAL due time, not a full backstop after the reload.
		const resumed = waitForEventCount(third.events, "goal_continuation_resumed", 1);
		await vi.advanceTimersByTimeAsync((parked?.dueAtMs ?? 0) - Date.now());
		await resumed;
		expect(warmupEntries(third)).toEqual([
			expect.objectContaining({ phase: "resumed", iteration: 2, waitedMs: BACKSTOP_DELAY_MS }),
		]);
	});

	it("starts a fresh wait when the branch holds no pending wait for the goal", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const generations: GoalHarness[] = [];
		const base = await makeGoalContext([], "thread-cache-warm-reload-fresh", { pendingMessages: false });
		const ctx = branchContext(base, generations);
		const first = createGoalHarness();
		generations.push(first);
		await runGoalHandlers(first.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await first.tools
			.get("create_goal")
			?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);

		const second = await reloadInto(generations, ctx);

		expect(warmupEntries(second)).toEqual([
			expect.objectContaining({ phase: "scheduled", iteration: 1, dueAtMs: BACKSTOP_DELAY_MS }),
		]);
	});
});
