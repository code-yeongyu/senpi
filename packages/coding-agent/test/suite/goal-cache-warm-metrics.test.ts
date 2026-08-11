import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	estimateCacheWarmMetrics,
	resolveGoalMonitorContinuationDelayMs,
} from "../../src/core/extensions/builtin/goal/cache-warm.ts";

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

describe("goal monitor continuation delay", () => {
	it.each([
		[undefined, undefined, 240_000],
		[270, undefined, 270_000],
		[3570, undefined, 3_570_000],
		[3570, 900, 900_000],
		[5, undefined, 5_000],
		[7200, undefined, 3_600_000],
		[270, 0, 270_000],
		[0, undefined, 240_000],
		[Number.NaN, undefined, 240_000],
	] as const)("resolves cache-safe wait %s with ceiling %s to %sms", (safeWait, ceiling, expected) => {
		expect(resolveGoalMonitorContinuationDelayMs(safeWait, ceiling)).toBe(expected);
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
