import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	estimateCacheWarmMetrics,
	GOAL_CACHE_WARMUP_ENTRY_TYPE,
	GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
	GOAL_MONITOR_BEST_EFFORT_BACKSTOP_SECONDS,
	resolveGoalBackstopMaxSecondsForCache,
	resolveGoalMonitorContinuationDelayMs,
} from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import { findParkedGoalWait } from "../../src/core/extensions/builtin/goal/parked-wait.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

function anthropicModel(costOverrides: Partial<Model<Api>["cost"]> = {}): Model<Api> {
	return {
		id: "claude-cache-test",
		name: "Claude Cache Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://gateway.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, ...costOverrides },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<Api>;
}

function deepseekModel(): Model<Api> {
	return {
		...anthropicModel(),
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
	} as Model<Api>;
}

function gpt6Model(): Model<Api> {
	return {
		...anthropicModel(),
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
	} as Model<Api>;
}

// code-yeongyu/senpi#831: a best-effort cache has no TTL for the default 270s re-check to land inside.
describe("goal backstop for the active prompt-cache lifetime (#831)", () => {
	it.each([
		[undefined, GOAL_MONITOR_BEST_EFFORT_BACKSTOP_SECONDS],
		[GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS / 1000, GOAL_MONITOR_BEST_EFFORT_BACKSTOP_SECONDS],
		[900, 900],
		[60, 60],
	] as const)("maps a best-effort backstop of %s to %s seconds", (configured, expected) => {
		expect(resolveGoalBackstopMaxSecondsForCache(configured, { kind: "best-effort" })).toBe(expected);
	});

	it("keeps the configured backstop on explicit-TTL and unknown lanes", () => {
		expect(resolveGoalBackstopMaxSecondsForCache(270, { kind: "ttl", ttlSeconds: 1800 })).toBe(270);
		expect(resolveGoalBackstopMaxSecondsForCache(undefined, { kind: "ttl", ttlSeconds: 300 })).toBeUndefined();
		expect(resolveGoalBackstopMaxSecondsForCache(270, { kind: "none" })).toBe(270);
		expect(resolveGoalBackstopMaxSecondsForCache(270, undefined)).toBe(270);
	});

	it("never arms the 270s cache-preservation wake for a best-effort lane by default", () => {
		const delayMs = resolveGoalMonitorContinuationDelayMs(
			resolveGoalBackstopMaxSecondsForCache(270, { kind: "best-effort" }),
		);
		expect(delayMs).toBe(3_570_000);
		expect(delayMs).not.toBe(270_000);
	});
});

describe("goal monitor backstop delay", () => {
	it.each([
		[undefined, 270_000],
		[3570, 3_570_000],
		[900, 900_000],
		[5, 5_000],
		[7200, 3_600_000],
		[0, 270_000],
		[-30, 270_000],
		[Number.NaN, 270_000],
	] as const)("resolves backstop ceiling %s to %sms", (backstopMaxSeconds, expected) => {
		expect(resolveGoalMonitorContinuationDelayMs(backstopMaxSeconds)).toBe(expected);
	});

	it("defaults to a re-check inside the 5-minute prompt-cache TTL", () => {
		// A wake source that never delivers must not park the goal for an hour:
		// the default floor is the 5m Anthropic TTL minus the 30s safety buffer.
		expect(GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS).toBe(270_000);
		expect(resolveGoalMonitorContinuationDelayMs(undefined)).toBe(270_000);
	});

	it("is configured, not derived from the prompt-cache safe wait", () => {
		// The delay takes only the configured ceiling; a longer TTL or a different
		// safety buffer never changes it.
		expect(resolveGoalMonitorContinuationDelayMs.length).toBe(1);
	});
});

describe("goal cache-warm metrics", () => {
	it("returns undefined when neither ttl nor cached tokens are knowable", () => {
		expect(estimateCacheWarmMetrics(undefined, {}, undefined)).toBeUndefined();
		expect(estimateCacheWarmMetrics(undefined, {}, { cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
	});

	it("reports cached tokens even without a model", () => {
		const metrics = estimateCacheWarmMetrics(undefined, {}, { cacheRead: 1000, cacheWrite: 200 });
		expect(metrics?.cachedTokens).toBe(1200);
		expect(metrics?.ttlSeconds).toBeUndefined();
		expect(metrics?.estimatedSavedUsd).toBeUndefined();
	});

	it("derives ttl and estimated savings for a cache-capable model", () => {
		const metrics = estimateCacheWarmMetrics(anthropicModel(), {}, { cacheRead: 100_000, cacheWrite: 20_000 });
		expect(metrics?.cachedTokens).toBe(120_000);
		expect(metrics?.ttlSeconds).toBe(300);
		expect(metrics?.estimatedSavedUsd).toBeCloseTo(0.324, 6);
	});

	it("keeps ttl-only metrics before anything is cached", () => {
		const metrics = estimateCacheWarmMetrics(anthropicModel(), {}, { cacheRead: 0, cacheWrite: 0 });
		expect(metrics?.cachedTokens).toBe(0);
		expect(metrics?.ttlSeconds).toBe(300);
		expect(metrics?.estimatedSavedUsd).toBeUndefined();
	});

	it("reports a best-effort cache without a TTL or savings estimate (#831)", () => {
		expect(estimateCacheWarmMetrics(deepseekModel(), {}, { cacheRead: 100_000, cacheWrite: 20_000 })).toEqual({
			cachedTokens: 120_000,
			cacheLifetime: "best-effort",
		});
		expect(estimateCacheWarmMetrics(deepseekModel(), {}, { cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
	});

	it("derives the 30-minute OpenAI GPT-6 TTL (#2090)", () => {
		const metrics = estimateCacheWarmMetrics(gpt6Model(), {}, { cacheRead: 100_000, cacheWrite: 0 });
		expect(metrics?.ttlSeconds).toBe(1800);
		expect(metrics?.cacheLifetime).toBeUndefined();
	});

	it("restores the best-effort marker from a parked wait entry", () => {
		const entry = {
			type: "custom",
			id: "parked",
			parentId: null,
			timestamp: "2026-09-24T00:00:00.000Z",
			customType: GOAL_CACHE_WARMUP_ENTRY_TYPE,
			data: {
				phase: "scheduled",
				goalId: "goal-1",
				iteration: 1,
				delayMs: 3_570_000,
				dueAtMs: 3_570_000,
				activeMonitorCount: 1,
				cache: { cachedTokens: 120_000, cacheLifetime: "best-effort" },
			},
		} as SessionEntry;
		expect(findParkedGoalWait([entry], "goal-1")?.cache).toEqual({
			cachedTokens: 120_000,
			cacheLifetime: "best-effort",
		});
	});

	it("clamps malformed usage and negative cache margins", () => {
		expect(estimateCacheWarmMetrics(undefined, {}, { cacheRead: -50, cacheWrite: Number.NaN })).toBeUndefined();
		const inverted = estimateCacheWarmMetrics(
			anthropicModel({ input: 0.2, cacheRead: 0.5 }),
			{},
			{ cacheRead: 1000, cacheWrite: 0 },
		);
		expect(inverted?.estimatedSavedUsd).toBe(0);
	});
});
