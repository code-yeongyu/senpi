import { beforeAll, describe, expect, it } from "vitest";
import type { GoalCacheWarmupEntryData } from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import { renderGoalCacheWarmupEntry } from "../../src/core/extensions/builtin/goal/cache-warm-renderer.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function warmupEntry(data: GoalCacheWarmupEntryData): CustomEntry<GoalCacheWarmupEntryData> {
	return {
		type: "custom",
		id: "entry-cache-warm",
		parentId: null,
		timestamp: "2026-07-29T00:00:00.000Z",
		customType: "goal-cache-warmup",
		data,
	};
}

function renderToText(data: GoalCacheWarmupEntryData, expanded = false): string {
	const component = renderGoalCacheWarmupEntry(warmupEntry(data), { expanded }, theme);
	const lines = component?.render(100) ?? [];
	return lines.join("\n").replace(ANSI_PATTERN, "");
}

describe("goal cache-warm entry renderer", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the scheduled wait with the cache story", () => {
		const text = renderToText({
			phase: "scheduled",
			goalId: "goal-1",
			delayMs: 270_000,
			activeMonitorCount: 1,
			iteration: 2,
			cache: { ttlSeconds: 300, cachedTokens: 120_000, estimatedSavedUsd: 0.324 },
		});
		expect(text).toContain("Cache-warm wait · iteration 2");
		expect(text).toContain("1 wake source on duty");
		expect(text).toContain("5m prompt-cache TTL");
		expect(text).toContain("~120K tokens kept warm");
		expect(text).toContain("$0.324 saved");
	});

	it("renders the resumed wake with savings", () => {
		const text = renderToText({
			phase: "resumed",
			goalId: "goal-1",
			delayMs: 270_000,
			waitedMs: 270_000,
			activeMonitorCount: 2,
			iteration: 3,
			cache: { ttlSeconds: 300, cachedTokens: 120_000, estimatedSavedUsd: 0.324 },
		});
		expect(text).toContain("Cache-warm wake · iteration 3");
		expect(text).toContain("waited 4m 30s");
		expect(text).toContain("2 wake sources on duty");
		expect(text).toContain("~120K tokens stayed warm");
		expect(text).toContain("$0.324 saved");
	});

	it("does not claim warmth or savings when the cache TTL may have elapsed", () => {
		const scheduled = renderToText({
			phase: "scheduled",
			goalId: "goal-expired-scheduled",
			delayMs: 300_000,
			activeMonitorCount: 1,
			cache: { ttlSeconds: 300, cachedTokens: 120_000, estimatedSavedUsd: 0.324 },
		});
		expect(scheduled).toContain("TTL may elapse");
		expect(scheduled).not.toContain("stays inside");
		expect(scheduled).not.toContain("kept warm");
		expect(scheduled).not.toContain("saved");

		const resumed = renderToText({
			phase: "resumed",
			goalId: "goal-expired-resumed",
			delayMs: 270_000,
			waitedMs: 300_000,
			activeMonitorCount: 1,
			cache: { ttlSeconds: 300, cachedTokens: 120_000, estimatedSavedUsd: 0.324 },
		});
		expect(resumed).toContain("TTL may have elapsed");
		expect(resumed).not.toContain("stayed warm");
		expect(resumed).not.toContain("saved");
	});

	it("stays readable without cache metrics", () => {
		const text = renderToText({
			phase: "scheduled",
			goalId: "goal-1",
			delayMs: 240_000,
			activeMonitorCount: 1,
		});
		expect(text).toContain("Cache-warm wait");
		expect(text).toContain("1 wake source on duty");
		expect(text).not.toContain("tokens");
	});

	it("renders legacy persisted entries without inventing an iteration", () => {
		const text = renderToText({
			phase: "scheduled",
			goalId: "legacy-goal",
			delayMs: 240_000,
			activeMonitorCount: 1,
		});
		expect(text).toContain("Cache-warm wait");
		expect(text).not.toContain("iteration");
	});

	it("reveals goal details when expanded", () => {
		const collapsed = renderToText({
			phase: "resumed",
			goalId: "goal-42",
			delayMs: 240_000,
			waitedMs: 200_000,
			activeMonitorCount: 1,
			cache: { cachedTokens: 500 },
		});
		expect(collapsed).not.toContain("goal-42");

		const expanded = renderToText(
			{
				phase: "resumed",
				goalId: "goal-42",
				delayMs: 240_000,
				waitedMs: 200_000,
				activeMonitorCount: 1,
				cache: { cachedTokens: 500 },
			},
			true,
		);
		expect(expanded).toContain("goal-42");
		expect(expanded).toContain("waited 3m 20s");
	});
});
