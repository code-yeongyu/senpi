import { describe, expect, it } from "vitest";
import {
	baseThresholdRatioForWindow,
	computeAdaptiveThresholdRatio,
	computeEffectiveThreshold,
} from "../../src/core/extensions/builtin/compaction/policy.ts";

const MIN_THRESHOLD_RATIO = 0.4;
const MAX_THRESHOLD_RATIO = 0.85;

const CONTEXT_WINDOWS = [
	0,
	-1,
	1,
	1_000,
	16_000,
	16_001,
	32_000,
	64_000,
	128_000,
	200_000,
	512_000,
	512_001,
	1_000_000,
	2_000_000,
	Number.MAX_SAFE_INTEGER,
];

const YIELDS = [
	{ savedTokens: 0, tokensBefore: 0 },
	{ savedTokens: 0, tokensBefore: 1 },
	{ savedTokens: 1, tokensBefore: 0 },
	{ savedTokens: 1, tokensBefore: -1 },
	{ savedTokens: 0, tokensBefore: 1_000_000 },
	{ savedTokens: 500, tokensBefore: 500_000 },
	{ savedTokens: 9_000, tokensBefore: 10_000 },
	{ savedTokens: 1_000_000, tokensBefore: 1_000 },
	{ savedTokens: -1_000_000, tokensBefore: 1_000 },
	{ savedTokens: Number.MAX_SAFE_INTEGER, tokensBefore: 1 },
];

describe("compaction policy: effective threshold clamp bounds", () => {
	describe("Given every combination of context window and prior-yield feedback", () => {
		describe("When the effective threshold is computed", () => {
			it("Then the result always stays inside [0.40, 0.85]", () => {
				// when / then
				for (const contextWindow of CONTEXT_WINDOWS) {
					const bare = computeEffectiveThreshold(contextWindow);
					expect(bare).toBeGreaterThanOrEqual(MIN_THRESHOLD_RATIO);
					expect(bare).toBeLessThanOrEqual(MAX_THRESHOLD_RATIO);

					for (const lastYield of YIELDS) {
						const effective = computeEffectiveThreshold(contextWindow, lastYield);
						expect(effective).toBeGreaterThanOrEqual(MIN_THRESHOLD_RATIO);
						expect(effective).toBeLessThanOrEqual(MAX_THRESHOLD_RATIO);
					}
				}
			});
		});
	});

	describe("Given a 1M context window whose base threshold is 0.80", () => {
		describe("When prior-yield feedback of every shape is applied", () => {
			it("Then low-yield feedback never pushes the threshold above the base ratio", () => {
				// given
				const contextWindow = 1_000_000;
				const baseRatio = baseThresholdRatioForWindow(contextWindow);
				expect(baseRatio).toBe(0.8);

				// when / then
				for (const lastYield of YIELDS) {
					const effective = computeEffectiveThreshold(contextWindow, lastYield);
					expect(effective).toBeLessThanOrEqual(baseRatio);
					expect(effective).toBeGreaterThanOrEqual(MIN_THRESHOLD_RATIO);
				}

				expect(computeEffectiveThreshold(contextWindow, { savedTokens: 500, tokensBefore: 500_000 })).toBe(0.8);
				expect(computeAdaptiveThresholdRatio(contextWindow, 500)).toBeLessThanOrEqual(baseRatio);
			});
		});
	});

	describe("Given a 1M context window and a numeric prior-yield argument", () => {
		describe("When the effective threshold is computed", () => {
			it("Then the legacy numeric escape hatch cannot return a token count", () => {
				// when
				const effective = (computeEffectiveThreshold as (w: number, y?: unknown) => number)(1_000_000, 0.5);

				// then
				expect(effective).toBeLessThanOrEqual(MAX_THRESHOLD_RATIO);
				expect(effective).toBeGreaterThanOrEqual(MIN_THRESHOLD_RATIO);
				expect(effective).toBe(baseThresholdRatioForWindow(1_000_000));
			});
		});
	});

	describe("Given a threshold ratio used as a trigger point", () => {
		describe("When the ratio is multiplied by the context window", () => {
			it("Then the trigger tokens always remain below the window itself", () => {
				// when / then
				for (const contextWindow of [16_000, 200_000, 1_000_000, 2_000_000]) {
					for (const lastYield of YIELDS) {
						const triggerTokens = contextWindow * computeEffectiveThreshold(contextWindow, lastYield);
						expect(triggerTokens).toBeLessThan(contextWindow);
					}
				}
			});
		});
	});
});
