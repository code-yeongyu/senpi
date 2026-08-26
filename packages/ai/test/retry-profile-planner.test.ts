import { describe, expect, it } from "vitest";
import { planRetryDelay } from "../src/utils/retry-profile/planner.ts";
import type { RetryFailure, RetryStagePolicy } from "../src/utils/retry-profile/types.ts";

// kimi-code-like stage: 500ms base, x2, 32s cap, +0..25% additive jitter.
const kimiBackoff = {
	baseDelayMs: 500,
	growthFactor: 2,
	perAttemptCapMs: 32_000,
	jitter: { mode: "additive", ratio: 0.25 },
} as const;

// Kimi stage: override mode, zero hints rejected, no ceiling.
const kimiStage: RetryStagePolicy = {
	enabled: true,
	maxRetries: 5,
	backoff: kimiBackoff,
	extractServerHint: (failure) => failure.retryAfterMs,
	serverHint: {
		mode: "override",
		acceptZero: false,
		ceiling: { maxDelayMs: null, onExceeded: "error-with-marker" },
	},
	classify: () => ({ verdict: "transient" }),
};

// Senpi provider-request stage: override mode with a 60s ceiling; hints
// strictly above it must surface as over-ceiling (error-with-marker).
const senpiProviderStage: RetryStagePolicy = {
	enabled: true,
	maxRetries: 3,
	backoff: {
		baseDelayMs: 500,
		growthFactor: 2,
		perAttemptCapMs: 8_000,
		jitter: { mode: "subtractive", ratio: 0.25 },
	},
	extractServerHint: (failure) => failure.retryAfterMs,
	serverHint: {
		mode: "override",
		acceptZero: false,
		ceiling: { maxDelayMs: 60_000, onExceeded: "error-with-marker" },
	},
	classify: () => ({ verdict: "rate-limited" }),
};

// Tiered stage: the real tier engine lives in coding-agent's hint-policy
// module, so the planner just flags the hint's presence as "delegated".
const tieredStage: RetryStagePolicy = {
	enabled: true,
	maxRetries: 3,
	backoff: kimiBackoff,
	extractServerHint: (failure) => failure.retryAfterMs,
	serverHint: {
		mode: "tiered",
		strategy: () => ({ tier: "senpi:probe", delayMs: 1 }),
	},
	classify: () => ({ verdict: "rate-limited" }),
};

function failureWith(retryAfterMs?: number): RetryFailure {
	return {
		origin: "test",
		kind: "http-status",
		message: "429",
		statusCode: 429,
		retryAfterMs,
	};
}

describe("planRetryDelay", () => {
	it("kimi override stage: positive hint replaces the computed delay entirely (42 beats backoff)", () => {
		expect(planRetryDelay(kimiStage, failureWith(42), 1, 0)).toEqual({
			kind: "wait",
			delayMs: 42,
		});
	});

	it("kimi override stage with acceptZero false: zero hint falls back to computed backoff (500)", () => {
		expect(planRetryDelay(kimiStage, failureWith(0), 1, 0)).toEqual({
			kind: "wait",
			delayMs: 500,
		});
	});

	it("kimi override stage: absent hint falls back to computed backoff (500)", () => {
		expect(planRetryDelay(kimiStage, failureWith(undefined), 1, 0)).toEqual({
			kind: "wait",
			delayMs: 500,
		});
	});

	it("kimi override stage with null ceiling: an hour-long hint is honoured verbatim", () => {
		expect(planRetryDelay(kimiStage, failureWith(3_600_000), 1, 0)).toEqual({
			kind: "wait",
			delayMs: 3_600_000,
		});
	});

	it("senpi provider override stage: hint strictly above the 60s ceiling is over-ceiling", () => {
		expect(planRetryDelay(senpiProviderStage, failureWith(90_000), 1, 0)).toEqual({
			kind: "over-ceiling",
			requestedMs: 90_000,
		});
	});

	it("senpi provider override stage: hint within the ceiling is used as-is", () => {
		expect(planRetryDelay(senpiProviderStage, failureWith(5_000), 1, 0)).toEqual({
			kind: "wait",
			delayMs: 5_000,
		});
	});

	it("tiered stage: present hint is delegated (tier label, computed delay)", () => {
		expect(planRetryDelay(tieredStage, failureWith(7_000), 2, 0)).toEqual({
			kind: "tiered",
			tier: "delegated",
			delayMs: 1_000,
		});
	});

	it("tiered stage: absent hint waits on the computed backoff", () => {
		expect(planRetryDelay(tieredStage, failureWith(undefined), 1, 0)).toEqual({
			kind: "wait",
			delayMs: 500,
		});
	});
});
