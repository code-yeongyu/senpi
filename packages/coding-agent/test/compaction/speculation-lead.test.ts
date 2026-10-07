import { describe, expect, it } from "vitest";
import type { CompactionSettings } from "../../src/core/compaction/index.ts";
import { shouldWarmAtIdle } from "../../src/core/extensions/builtin/compaction/idle.ts";
import {
	isWarmResultStale,
	isWithinGraceBand,
	resolveGraceBandCapTokens,
	resolveSpeculationLeadTokens,
	SPECULATION_LEAD_MAX_TOKENS,
	SPECULATION_LEAD_MIN_TOKENS,
	WARM_GENERATION_FLOOR_RATIO,
} from "../../src/core/extensions/builtin/compaction/speculation-lead.ts";

const settings: CompactionSettings = { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 };

function idleDecision(tokens: number | null, overrides: Record<string, unknown> = {}) {
	return {
		willRetry: false,
		aborted: false,
		settings,
		usage:
			tokens === null
				? { tokens: null, contextWindow: 100_000, percent: 0 }
				: { tokens, contextWindow: 100_000, percent: tokens / 1000 },
		contextWindow: 100_000,
		breakerTripped: false,
		mode: "tui" as const,
		...overrides,
	};
}

describe("speculation lead geometry", () => {
	it("clamps the absolute lead between its floor and cap", () => {
		expect(resolveSpeculationLeadTokens(50_000)).toBe(SPECULATION_LEAD_MIN_TOKENS);
		expect(resolveSpeculationLeadTokens(200_000)).toBe(25_000);
		expect(resolveSpeculationLeadTokens(800_000)).toBe(SPECULATION_LEAD_MAX_TOKENS);
		expect(resolveSpeculationLeadTokens(140_000, 1)).toBe(SPECULATION_LEAD_MIN_TOKENS);
		expect(resolveSpeculationLeadTokens(140_000, 1_000_000)).toBe(SPECULATION_LEAD_MAX_TOKENS);
	});

	it("caps the grace band at the reserved context window", () => {
		expect(resolveGraceBandCapTokens(100_000, 12_500, 200_000, 10_000)).toBe(112_500);
		expect(resolveGraceBandCapTokens(200_000, 25_000, 210_000, 10_000)).toBe(200_000);
	});

	it("uses an exclusive grace-band upper boundary", () => {
		const cap = resolveGraceBandCapTokens(100_000, 12_500, 200_000, 10_000);
		expect(isWithinGraceBand(cap, 100_000, 12_500, 200_000, 10_000)).toBe(false);
		expect(isWithinGraceBand(cap - 1, 100_000, 12_500, 200_000, 10_000)).toBe(true);
	});

	it("warms at or above half the context window without requiring threshold", () => {
		expect(WARM_GENERATION_FLOOR_RATIO).toBe(0.5);
		expect(shouldWarmAtIdle(idleDecision(49_900))).toBe(false);
		expect(shouldWarmAtIdle(idleDecision(50_000))).toBe(true);
	});

	it("preserves the idle eligibility guards", () => {
		expect(shouldWarmAtIdle(idleDecision(50_000, { willRetry: true }))).toBe(false);
		expect(shouldWarmAtIdle(idleDecision(50_000, { aborted: true }))).toBe(false);
		expect(shouldWarmAtIdle(idleDecision(50_000, { mode: "print" }))).toBe(false);
		expect(shouldWarmAtIdle(idleDecision(50_000, { breakerTripped: true }))).toBe(false);
		expect(shouldWarmAtIdle(idleDecision(null))).toBe(false);
	});

	it("marks a warm result stale only after the growth budget is exceeded", () => {
		expect(isWarmResultStale(50_000, 58_192, 1_000)).toBe(false);
		expect(isWarmResultStale(50_000, 58_193, 1_000)).toBe(true);
		expect(isWarmResultStale(50_000, 70_000, 20_000)).toBe(false);
		expect(isWarmResultStale(50_000, 70_001, 20_000)).toBe(true);
	});
});
