import { describe, expect, it } from "vitest";
import {
	computeEffectiveBlockingThresholdTokens,
	DEFAULT_1M_KEEP_RECENT,
	resolveContextBudgetPolicy,
	shouldStartSpeculativeCompaction,
	shouldTriggerCompaction,
} from "../../src/core/extensions/builtin/compaction/policy.ts";
import type { ContextUsage } from "../../src/core/extensions/types.ts";

function usage(tokens: number, contextWindow: number): ContextUsage {
	return {
		tokens,
		contextWindow,
		percent: (tokens / contextWindow) * 100,
	};
}

describe("ContextBudgetPolicy & Compaction Thresholds (Phase 0-3 Matrices)", () => {
	const defaultSettings = {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: 20_000,
	};

	describe("Case A: 200k model compatibility", () => {
		it("does not force 384k ceiling on 200k models", () => {
			const policy = resolveContextBudgetPolicy(200_000, defaultSettings);
			expect(policy.physicalContextWindow).toBe(200_000);
			expect(policy.maxActiveContextTokens).toBe(200_000 - 16_384);
			expect(policy.keepRecentTokens).toBe(20_000);

			const blocking = computeEffectiveBlockingThresholdTokens(200_000, defaultSettings);
			// 200k * 0.65 = 130k (< 183.6k maxActive)
			expect(blocking).toBe(130_000);

			// 120k < 130k -> no trigger
			expect(shouldTriggerCompaction(usage(120_000, 200_000), 200_000, defaultSettings)).toBe(false);
			// 135k >= 130k -> trigger
			expect(shouldTriggerCompaction(usage(135_000, 200_000), 200_000, defaultSettings)).toBe(true);
		});
	});

	describe("Case B & C: 1M model warmup (speculative) threshold around 288k", () => {
		it("triggers speculative compaction at 288k (75% of 384k)", () => {
			const policy = resolveContextBudgetPolicy(1_000_000, { enabled: true, reserveTokens: 16_384 });
			expect(policy.maxActiveContextTokens).toBe(384_000);
			expect(policy.keepRecentTokens).toBe(DEFAULT_1M_KEEP_RECENT); // 35,000

			const blocking = computeEffectiveBlockingThresholdTokens(1_000_000, defaultSettings);
			expect(blocking).toBe(384_000);

			// 287k (< 288k) -> warmup 직전
			expect(shouldStartSpeculativeCompaction(usage(287_000, 1_000_000), 1_000_000, defaultSettings)).toBe(false);
			// 289k (>= 288k) -> warmup 시작
			expect(shouldStartSpeculativeCompaction(usage(289_000, 1_000_000), 1_000_000, defaultSettings)).toBe(true);
		});
	});

	describe("Case D & E: 1M model blocking compaction threshold at 384k", () => {
		it("caps blocking threshold at 384k despite 65% ratio being 650k", () => {
			const blocking = computeEffectiveBlockingThresholdTokens(1_000_000, defaultSettings);
			expect(blocking).toBe(384_000);

			// 383k -> blocking 직전
			expect(shouldTriggerCompaction(usage(383_000, 1_000_000), 1_000_000, defaultSettings)).toBe(false);
			// 385k -> blocking compaction 요구
			expect(shouldTriggerCompaction(usage(385_000, 1_000_000), 1_000_000, defaultSettings)).toBe(true);
		});
	});

	describe("Case F: Base footprint 155k + recent 35k post-compaction headroom", () => {
		it("does not immediately re-trigger compaction after compacting to ~190k", () => {
			const postCompactTokens = 155_000 + 35_000; // 190,000
			expect(shouldTriggerCompaction(usage(postCompactTokens, 1_000_000), 1_000_000, defaultSettings)).toBe(false);
			expect(shouldStartSpeculativeCompaction(usage(postCompactTokens, 1_000_000), 1_000_000, defaultSettings)).toBe(
				false,
			);
		});
	});

	describe("User overrides prioritization", () => {
		it("respects explicit maxContextTokens and keepRecentTokens over defaults", () => {
			const customSettings = {
				enabled: true,
				reserveTokens: 20_000,
				keepRecentTokens: 40_000,
				maxContextTokens: 450_000,
				speculativeFraction: 0.8,
			};

			const policy = resolveContextBudgetPolicy(1_000_000, customSettings);
			expect(policy.maxActiveContextTokens).toBe(450_000);
			expect(policy.keepRecentTokens).toBe(40_000);
			expect(policy.warmupFraction).toBe(0.8);

			const blocking = computeEffectiveBlockingThresholdTokens(1_000_000, customSettings);
			expect(blocking).toBe(450_000);

			// 360k = 450k * 0.80
			expect(shouldStartSpeculativeCompaction(usage(359_000, 1_000_000), 1_000_000, customSettings)).toBe(false);
			expect(shouldStartSpeculativeCompaction(usage(361_000, 1_000_000), 1_000_000, customSettings)).toBe(true);
		});
	});
});
