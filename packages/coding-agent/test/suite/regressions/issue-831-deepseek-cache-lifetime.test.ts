import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	GoalCacheWarmMetrics,
	GoalCacheWarmupEntryData,
} from "../../../src/core/extensions/builtin/goal/cache-warm.ts";
import { renderGoalCacheWarmupEntry } from "../../../src/core/extensions/builtin/goal/cache-warm-renderer.ts";
import type { CustomEntry } from "../../../src/core/session-manager.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const LIVENESS_BACKSTOP_MS = 3_570_000;

function deepseekModel(): Model<Api> {
	return {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 128_000,
		maxTokens: 8192,
	} as Model<Api>;
}

type ScheduledContinuationEvent = {
	readonly goalId: string;
	readonly delayMs: number;
	readonly iteration: number;
	readonly activeMonitorCount: number;
	readonly wakeSources: Readonly<Record<string, number>>;
	readonly cache?: GoalCacheWarmMetrics;
};

function scheduledEvent(harness: GoalHarness): ScheduledContinuationEvent | undefined {
	const event = harness.events.emitted.find((entry) => entry.channel === "goal_continuation_scheduled");
	return event?.data as ScheduledContinuationEvent | undefined;
}

function renderEntry(data: GoalCacheWarmupEntryData): string {
	const entry: CustomEntry<GoalCacheWarmupEntryData> = {
		type: "custom",
		id: "entry-issue-831",
		parentId: null,
		timestamp: "2026-08-12T00:00:00.000Z",
		customType: "goal-cache-warmup",
		data,
	};
	const component = renderGoalCacheWarmupEntry(entry, { expanded: false }, theme);
	return (component?.render(100) ?? []).join("\n").replace(ANSI_PATTERN, "");
}

async function setupDeepSeekHarness(
	threadId: string,
	state: { readonly goalBackstopMaxSeconds?: number } = {},
): Promise<{ harness: GoalHarness; notices: string[]; ctx: Awaited<ReturnType<typeof makeGoalContext>> }> {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId, {
		pendingMessages: false,
		model: deepseekModel(),
		goalBackstopMaxSeconds: state.goalBackstopMaxSeconds,
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

describe("issue #831: direct DeepSeek must not wake the goal every 4m30 for a fabricated 5m TTL", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("schedules the monitor continuation at the liveness backstop, not a cache-preservation delay", async () => {
		vi.useFakeTimers();
		const { harness } = await setupDeepSeekHarness("issue-831-deepseek-cache-lifetime");

		const scheduled = scheduledEvent(harness);
		expect(scheduled).toBeDefined();
		expect(scheduled?.delayMs).toBe(LIVENESS_BACKSTOP_MS);
		expect(scheduled?.cache?.ttlSeconds).toBeUndefined();
		expect(scheduled?.cache?.estimatedSavedUsd).toBeUndefined();
		expect(scheduled?.cache).toEqual(expect.objectContaining({ cachedTokens: 120_000, cacheLifetime: "automatic" }));

		await vi.advanceTimersByTimeAsync(LIVENESS_BACKSTOP_MS - 1);
		expect(harness.sent).toHaveLength(0);
		const delivered = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(1);
		await delivered;
		expect(harness.sent).toHaveLength(1);
	});

	it("honors the configured goal backstop as the automatic-cache liveness ceiling", async () => {
		vi.useFakeTimers();
		const { harness } = await setupDeepSeekHarness("issue-831-deepseek-cache-backstop", {
			goalBackstopMaxSeconds: 900,
		});

		expect(scheduledEvent(harness)?.delayMs).toBe(900_000);
		await vi.advanceTimersByTimeAsync(899_999);
		expect(harness.sent).toHaveLength(0);
		const delivered = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(1);
		await delivered;
		expect(harness.sent).toHaveLength(1);
	});

	it("renders the automatic-cache wait without TTL, warmth, or savings claims", () => {
		const text = renderEntry({
			phase: "scheduled",
			goalId: "goal-issue-831",
			delayMs: LIVENESS_BACKSTOP_MS,
			dueAtMs: 1_786_492_800_000 + LIVENESS_BACKSTOP_MS,
			iteration: 1,
			activeMonitorCount: 1,
			cache: { cachedTokens: 120_000, cacheLifetime: "automatic" },
		});

		expect(text).toContain("Continuation expected ready 2026-08-12 00:59 UTC (59m 30s)");
		expect(text).toContain("provider caching is automatic");
		expect(text).toContain("timed wake only keeps the goal alive");
		expect(text).toContain("~120K tokens cached after the prior turn");
		expect(text).not.toContain("prompt-cache TTL");
		expect(text).not.toContain("kept warm");
		expect(text).not.toContain("saved");
	});

	it("renders the resumed automatic-cache wake neutrally", () => {
		const text = renderEntry({
			phase: "resumed",
			goalId: "goal-issue-831",
			delayMs: LIVENESS_BACKSTOP_MS,
			waitedMs: LIVENESS_BACKSTOP_MS,
			dueAtMs: 1_786_492_800_000 + LIVENESS_BACKSTOP_MS,
			iteration: 2,
			activeMonitorCount: 1,
			cache: { cachedTokens: 120_000, cacheLifetime: "automatic" },
		});

		expect(text).toContain("Cache-warm wake · iteration 2");
		expect(text).toContain("~120K tokens cached after the prior turn");
		expect(text).not.toContain("stayed warm");
		expect(text).not.toContain("saved");
		expect(text).not.toContain("prompt-cache TTL");
	});
});
