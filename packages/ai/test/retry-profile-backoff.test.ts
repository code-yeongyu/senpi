import { describe, expect, it } from "vitest";
import { retryBackoffDelayMs } from "../src/utils/retry-profile/backoff.ts";
import type { RetryBackoffPolicy } from "../src/utils/retry-profile/types.ts";

// kimi-code turn policy: 500ms base, x2, 32s per-attempt cap, +0..25% additive
// jitter (reimplemented from the documented policy, /tmp/kimi-code reference).
const kimiTurnBackoff: RetryBackoffPolicy = {
	baseDelayMs: 500,
	growthFactor: 2,
	perAttemptCapMs: 32_000,
	jitter: { mode: "additive", ratio: 0.25 },
};

// senpi-default turn policy: 2000ms base, x2, uncapped, no jitter.
const senpiTurnBackoff: RetryBackoffPolicy = {
	baseDelayMs: 2000,
	growthFactor: 2,
	perAttemptCapMs: null,
	jitter: { mode: "none" },
};

// senpi provider-request stage: 500ms base, x2, 8s cap, -0..25% subtractive
// jitter (mirrors min(0.5 * 2**i, 8) * 1000 * (1 - random * 0.25)).
const senpiProviderBackoff: RetryBackoffPolicy = {
	baseDelayMs: 500,
	growthFactor: 2,
	perAttemptCapMs: 8_000,
	jitter: { mode: "subtractive", ratio: 0.25 },
};

describe("retryBackoffDelayMs", () => {
	it("computes the kimi-like exponential ramp capped at 32s when jitter adds zero", () => {
		expect(retryBackoffDelayMs(kimiTurnBackoff, 1, 0)).toBe(500);
		const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((retryNumber) =>
			retryBackoffDelayMs(kimiTurnBackoff, retryNumber, 0),
		);
		expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000]);
	});

	it("applies additive jitter after the cap: random=1 gives 625 first and 40000 at the capped attempt", () => {
		expect(retryBackoffDelayMs(kimiTurnBackoff, 1, 1)).toBe(625);
		// Attempt 7: capped base is 32000 (cap BEFORE jitter), jitter adds 25%.
		expect(retryBackoffDelayMs(kimiTurnBackoff, 7, 1)).toBe(40_000);
	});

	it("computes the senpi turn delays [2000, 4000, 8000] for any random sample (jitter none)", () => {
		for (const random of [0, 0.5, 0.999999]) {
			const delays = [1, 2, 3].map((retryNumber) => retryBackoffDelayMs(senpiTurnBackoff, retryNumber, random));
			expect(delays).toEqual([2000, 4000, 8000]);
		}
		// Uncapped policy keeps growing past the kimi ramp's attempt-7 plateau.
		expect(retryBackoffDelayMs(senpiTurnBackoff, 4, 0.25)).toBe(16_000);
	});

	it("applies subtractive jitter: random=1 shaves 25% off the first provider-stage delay", () => {
		expect(retryBackoffDelayMs(senpiProviderBackoff, 1, 1)).toBe(375);
		// Subtractive jitter with random=0 leaves the capped base untouched.
		expect(retryBackoffDelayMs(senpiProviderBackoff, 3, 0)).toBe(2000);
	});

	it("treats perAttemptCapMs 0 as a literal zero cap for every retryNumber", () => {
		const zeroCap: RetryBackoffPolicy = {
			baseDelayMs: 500,
			growthFactor: 2,
			perAttemptCapMs: 0,
			jitter: { mode: "additive", ratio: 0.25 },
		};
		const delays = [1, 2, 3, 4, 5].map((retryNumber) => retryBackoffDelayMs(zeroCap, retryNumber, 0.5));
		expect(delays).toEqual([0, 0, 0, 0, 0]);
	});

	it("honours a non-doubling growth factor on the 1-based exponent", () => {
		const policy: RetryBackoffPolicy = {
			baseDelayMs: 100,
			growthFactor: 3,
			perAttemptCapMs: null,
			jitter: { mode: "none" },
		};
		expect(retryBackoffDelayMs(policy, 1, 0)).toBe(100);
		expect(retryBackoffDelayMs(policy, 2, 0)).toBe(300);
		expect(retryBackoffDelayMs(policy, 3, 0)).toBe(900);
	});
});

describe("phase-2: senpi-default 8s local turn cap (C2)", () => {
	it("caps computed local exponential at 8s for high attempts", () => {
		const policy = {
			baseDelayMs: 2000,
			growthFactor: 2,
			perAttemptCapMs: 8_000,
			jitter: { mode: "none" as const },
		};
		const delays = [1, 2, 3, 4, 5].map((n) => retryBackoffDelayMs(policy, n, 0));
		expect(delays).toEqual([2000, 4000, 8000, 8000, 8000]);
	});

	it("cap applies before jitter", () => {
		const policy = {
			baseDelayMs: 2000,
			growthFactor: 2,
			perAttemptCapMs: 8_000,
			jitter: { mode: "additive" as const, ratio: 0.25 },
		};
		expect(retryBackoffDelayMs(policy, 4, 1)).toBe(8_000 + 0.25 * 8_000);
	});
});
