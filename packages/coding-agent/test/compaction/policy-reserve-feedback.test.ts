import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	baseThresholdRatioForWindow,
	computeAdaptiveThresholdRatio,
	computeEffectiveKeepRecentTokens,
	computeEffectiveThreshold,
	resolveReserveTokens,
	shouldStartSpeculativeCompaction,
} from "../../src/core/extensions/builtin/compaction/policy.ts";

const CONFIGURED_RESERVE_TOKENS = 16_384;
const LOW_YIELD_SAVED_TOKENS = 500;
const HIGH_YIELD_SAVED_TOKENS = 9000;

describe("compaction policy: window-scaled reserve", () => {
	describe("Given a configured reserve of 16384 tokens", () => {
		describe("When the reserve is resolved for 200K, 1M and 2M windows", () => {
			it("Then the reserve scales with the window up to the 49152 ceiling", () => {
				// when / then
				expect(resolveReserveTokens(200_000, CONFIGURED_RESERVE_TOKENS)).toBe(16_384);
				expect(resolveReserveTokens(1_000_000, CONFIGURED_RESERVE_TOKENS)).toBe(40_000);
				expect(resolveReserveTokens(2_000_000, CONFIGURED_RESERVE_TOKENS)).toBe(49_152);
			});
		});
	});
});

describe("compaction policy: asymmetric yield feedback", () => {
	describe("Given a 1M context window whose base threshold is 0.80", () => {
		describe("When a low-yield prior compaction requests an upward adjustment", () => {
			it("Then the threshold stays at the base ratio", () => {
				// given
				const contextWindow = 1_000_000;
				expect(baseThresholdRatioForWindow(contextWindow)).toBe(0.8);

				// when
				const adaptive = computeAdaptiveThresholdRatio(contextWindow, LOW_YIELD_SAVED_TOKENS);
				const effective = computeEffectiveThreshold(contextWindow, {
					savedTokens: LOW_YIELD_SAVED_TOKENS,
					tokensBefore: 500_000,
				});

				// then
				expect(adaptive).toBe(0.8);
				expect(effective).toBe(0.8);
			});
		});
	});

	describe("Given a 1M context window already adjusted down to 0.75 by a high-yield compaction", () => {
		describe("When a later low-yield compaction pushes the threshold back up", () => {
			it("Then the threshold recovers to the base ratio but never above it", () => {
				// given
				const contextWindow = 1_000_000;
				const adjustedDown = computeEffectiveThreshold(contextWindow, {
					savedTokens: HIGH_YIELD_SAVED_TOKENS,
					tokensBefore: 10_000,
				});
				expect(adjustedDown).toBe(0.75);

				// when
				const recovered = computeEffectiveThreshold(contextWindow, {
					savedTokens: LOW_YIELD_SAVED_TOKENS,
					tokensBefore: 500_000,
				});

				// then
				expect(recovered).toBeLessThanOrEqual(baseThresholdRatioForWindow(contextWindow));
				expect(recovered).toBe(0.8);
			});
		});
	});

	describe("Given a 512K context window with a high-yield prior compaction", () => {
		describe("When the downward adjustment is applied", () => {
			it("Then the threshold still drops by 0.05", () => {
				// given
				const contextWindow = 512_000;

				// when
				const effective = computeEffectiveThreshold(contextWindow, {
					savedTokens: HIGH_YIELD_SAVED_TOKENS,
					tokensBefore: 10_000,
				});

				// then
				expect(baseThresholdRatioForWindow(contextWindow)).toBe(0.7);
				expect(effective).toBeCloseTo(0.65, 10);
				expect(effective).toBeLessThan(baseThresholdRatioForWindow(contextWindow));
			});
		});
	});
});

describe("compaction policy: lead-aware speculative trigger", () => {
	describe("Given a 200K context window and a speculative lead of 20000 tokens", () => {
		describe("When usage approaches the threshold minus the lead", () => {
			it("Then speculative compaction fires at the lead point and not below", () => {
				// given
				const contextWindow = 200_000;
				const leadTokens = 20_000;
				const settings = { ...DEFAULT_COMPACTION_SETTINGS, speculativeEnabled: true };
				const triggerTokens = contextWindow * computeEffectiveThreshold(contextWindow) - leadTokens;

				// when / then
				expect(
					shouldStartSpeculativeCompaction(
						{ tokens: triggerTokens - 1, contextWindow, percent: null },
						contextWindow,
						settings,
						undefined,
						leadTokens,
					),
				).toBe(false);
				expect(
					shouldStartSpeculativeCompaction(
						{ tokens: triggerTokens, contextWindow, percent: null },
						contextWindow,
						settings,
						undefined,
						leadTokens,
					),
				).toBe(true);
			});
		});
	});

	describe("Given no lead tokens are supplied", () => {
		describe("When speculative compaction is evaluated", () => {
			it("Then the legacy speculative fraction path is used", () => {
				// given
				const contextWindow = 200_000;
				const settings = { ...DEFAULT_COMPACTION_SETTINGS, speculativeEnabled: true };
				const triggerTokens = contextWindow * computeEffectiveThreshold(contextWindow) * 0.75;

				// when / then
				expect(
					shouldStartSpeculativeCompaction(
						{ tokens: triggerTokens - 1, contextWindow, percent: null },
						contextWindow,
						settings,
					),
				).toBe(false);
				expect(
					shouldStartSpeculativeCompaction(
						{ tokens: triggerTokens, contextWindow, percent: null },
						contextWindow,
						settings,
					),
				).toBe(true);
			});
		});
	});
});

describe("compaction policy: window-scaled keepRecentTokens", () => {
	describe("Given a 1M context window and the default keepRecentTokens setting", () => {
		describe("When the effective keepRecentTokens is computed", () => {
			it("Then the setting scales with the window before the remainder cap applies", () => {
				// given
				const contextWindow = 1_000_000;
				const thresholdRatio = computeEffectiveThreshold(contextWindow);

				// when
				const keepRecentTokens = computeEffectiveKeepRecentTokens(
					DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
					contextWindow,
					thresholdRatio,
				);

				// then
				expect(keepRecentTokens).toBe(50_000);
			});
		});
	});
});
