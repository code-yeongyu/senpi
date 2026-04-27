import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	computeAdaptiveThresholdRatio,
	computeEffectiveThreshold,
} from "../../src/core/extensions/builtin/compaction/policy.js";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../src/core/session-manager.js";

type AdaptiveRatioFn = (contextWindow: number, priorCompactionSavedTokens?: number) => number;
type EffectiveThresholdFn = (baseRatio: number, floorRatio: number) => number;

const adaptiveRatio = computeAdaptiveThresholdRatio as unknown as AdaptiveRatioFn;
const effectiveThreshold = computeEffectiveThreshold as unknown as EffectiveThresholdFn;

const HIGH_YIELD_SAVED_TOKENS = 9000;
const LOW_YIELD_SAVED_TOKENS = 500;
const OMO_FLOOR_RATIO = 0.78;

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

let adaptiveFixtureEntries: SessionEntry[] = [];

beforeAll(() => {
	const fixturePath = join(
		__dirname,
		"..",
		"fixtures",
		"compaction",
		"adaptive-threshold",
		"16k-near-threshold.jsonl",
	);
	const content = readFileSync(fixturePath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	adaptiveFixtureEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
});

describe("compaction policy: adaptive threshold ratio", () => {
	describe("Given a faux model with context window 16000", () => {
		describe("When the adaptive threshold ratio is computed for that window", () => {
			it("Then the ratio equals 0.45", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-16k", contextWindow: 16000 }],
				});
				registrations.push(registration);

				const model = registration.getModel("faux-16k");
				expect(model?.contextWindow).toBe(16000);
				expect(adaptiveFixtureEntries.length).toBeGreaterThan(0);

				const ratio = adaptiveRatio(model!.contextWindow);

				expect(ratio).toBe(0.45);
			});
		});
	});

	describe("Given a faux model with context window 32000", () => {
		describe("When the adaptive threshold ratio is computed for that window", () => {
			it("Then the ratio equals 0.50", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-32k", contextWindow: 32000 }],
				});
				registrations.push(registration);

				const ratio = adaptiveRatio(registration.getModel("faux-32k")!.contextWindow);

				expect(ratio).toBe(0.5);
			});
		});
	});

	describe("Given a faux model with context window 64000", () => {
		describe("When the adaptive threshold ratio is computed for that window", () => {
			it("Then the ratio equals 0.55", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-64k", contextWindow: 64000 }],
				});
				registrations.push(registration);

				const ratio = adaptiveRatio(registration.getModel("faux-64k")!.contextWindow);

				expect(ratio).toBe(0.55);
			});
		});
	});

	describe("Given a faux model with context window 128000", () => {
		describe("When the adaptive threshold ratio is computed for that window", () => {
			it("Then the ratio equals 0.60", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-128k", contextWindow: 128000 }],
				});
				registrations.push(registration);

				const ratio = adaptiveRatio(registration.getModel("faux-128k")!.contextWindow);

				expect(ratio).toBe(0.6);
			});
		});
	});

	describe("Given a faux model with context window 200000", () => {
		describe("When the adaptive threshold ratio is computed for that window", () => {
			it("Then the ratio equals 0.65", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-200k", contextWindow: 200000 }],
				});
				registrations.push(registration);

				const ratio = adaptiveRatio(registration.getModel("faux-200k")!.contextWindow);

				expect(ratio).toBe(0.65);
			});
		});
	});

	describe("Given a base ratio of 0.50 and the omo 78% floor for a 32000 window", () => {
		describe("When the effective threshold is computed against the floor", () => {
			it("Then the floor wins and the effective threshold equals 0.78", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-32k", contextWindow: 32000 }],
				});
				registrations.push(registration);

				const baseRatio = adaptiveRatio(registration.getModel("faux-32k")!.contextWindow);
				expect(baseRatio).toBe(0.5);

				const effective = effectiveThreshold(baseRatio, OMO_FLOOR_RATIO);

				expect(effective).toBe(OMO_FLOOR_RATIO);
				expect(effective).toBe(Math.max(baseRatio, OMO_FLOOR_RATIO));
			});
		});
	});

	describe("Given context window 16000 with a high-yield prior compaction (savedTokens > 8000)", () => {
		describe("When the next adaptive threshold ratio is computed", () => {
			it("Then the ratio drops by 0.05 and is clamped at the 0.40 floor", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-16k-high-yield", contextWindow: 16000 }],
				});
				registrations.push(registration);

				const baselineRatio = adaptiveRatio(registration.getModel("faux-16k-high-yield")!.contextWindow);
				const adjustedRatio = adaptiveRatio(
					registration.getModel("faux-16k-high-yield")!.contextWindow,
					HIGH_YIELD_SAVED_TOKENS,
				);

				expect(baselineRatio).toBe(0.45);
				expect(adjustedRatio).toBe(0.4);
				expect(adjustedRatio).toBeGreaterThanOrEqual(0.4);
			});
		});
	});

	describe("Given context window 16000 with a low-yield prior compaction (savedTokens < 1000)", () => {
		describe("When the next adaptive threshold ratio is computed", () => {
			it("Then the ratio rises by 0.05 and is clamped at the 0.70 ceiling", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-16k-low-yield", contextWindow: 16000 }],
				});
				registrations.push(registration);

				const baselineRatio = adaptiveRatio(registration.getModel("faux-16k-low-yield")!.contextWindow);
				const adjustedRatio = adaptiveRatio(
					registration.getModel("faux-16k-low-yield")!.contextWindow,
					LOW_YIELD_SAVED_TOKENS,
				);

				expect(baselineRatio).toBe(0.45);
				expect(adjustedRatio).toBe(0.5);
				expect(adjustedRatio).toBeLessThanOrEqual(0.7);
			});
		});
	});
});
