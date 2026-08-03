import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

// Error fixtures that are BOTH retryable (isRetryableAssistantError passes)
// AND carry rate-limit markers so the 429-class check fires.
const noHint429 = "HTTP 429: rate_limit_exceeded - All tokens rate limited";
const hint4ms = "HTTP 429: rate_limit_error (retry-after-ms: 4)";
const hint8ms = "HTTP 429: rate_limit_error (retry-after-ms: 8)";
const hint1258s = "HTTP 429: rate_limit_error (retry-after-ms: 1258000)";
const hint3600s = "HTTP 429: rate_limit_error (retry-after-ms: 3600000)";
// Non-429 transient — keeps today's exponential behavior.
const transient500 = "HTTP 500: internal_error";

function errorTurn(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("hint-aware 429 tier routing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	// (1) No-hint 429 -> fallback on FIRST failure, zero same-model retries.
	it("no-hint 429 falls back immediately with zero same-model retries", async () => {
		const now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(noHint429), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		// Primary was called exactly once (zero same-model retries).
		const primaryCalls = harness.faux.getCallLog().filter((c) => c.modelId === "faux-1").length;
		expect(primaryCalls).toBe(1);
		// Fallback was applied immediately.
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);
		// The fallback's retry sleep has delayMs 0 (fresh model, switchedFallback).
		expect(harness.eventsOfType("auto_retry_start").map((e) => e.delayMs)).toEqual([0]);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);
	});

	// (2) Hint 4ms -> two same-model waits (2ms half-probe, then 4ms fresh-hint deadline), then success.
	it("hint stays in-turn with half-then-deadline waits", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);

		// Two 429 errors with 4ms hint, then success on third call.
		harness.setResponses([errorTurn(hint4ms), errorTurn(hint4ms), fauxAssistantMessage("primary recovered")]);

		// Track time via the auto_retry_start event to advance fallbackNow.
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.delayMs > 0) now += event.delayMs;
		});

		await harness.session.prompt("hello");

		// No fallback should have been applied — stayed on same model.
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		// Two retry starts: first = ceil(4/2)=2 (half probe), second = 4 (fresh hint
		// creates a new deadline; the latest hint supersedes per the state machine).
		const delays = harness.eventsOfType("auto_retry_start").map((e) => e.delayMs);
		expect(delays).toEqual([2, 4]);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);
		// Primary was called 3 times (two errors + one success).
		const primaryCalls = harness.faux.getCallLog().filter((c) => c.modelId === "faux-1").length;
		expect(primaryCalls).toBe(3);
	});

	// (3) Cumulative hinted wait > cap demotes to tier2 fallback path.
	// hint 8ms, cap 8ms (tier1 since 8 <= 8).
	// First: delay = ceil(8/2) = 4, cumulative = 4 (< 8, tier1 continues)
	// Second: fresh hint 8ms -> new deadline, remaining = 8, cumulative = 4+8 = 12 (> 8, demote!)
	it("cumulative hinted wait exceeding cap demotes to fallback", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					hintedWaitCapMs: 8,
					probeBackMaxMs: 3_600_000,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);

		harness.setResponses([errorTurn(hint8ms), errorTurn(hint8ms), fauxAssistantMessage("fallback answer")]);

		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.delayMs > 0) now += event.delayMs;
		});

		await harness.session.prompt("hello");

		// Fallback was applied on the second 429 (demotion from tier1).
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);
		// First retry was on primary (delay 4ms = ceil(8/2)), then fallback (delay 0).
		const starts = harness.eventsOfType("auto_retry_start").map((e) => e.delayMs);
		expect(starts[0]).toBe(4);
		expect(starts[1]).toBe(0);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);
	});

	// (4) Hint 1_258_000ms -> immediate fallback on first failure, cooldown has remaining hint.
	it("hint 1258s falls back immediately (tier2) with remaining hint in cooldown", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(hint1258s), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		// Immediate fallback on first failure.
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);
		// Primary called exactly once.
		const primaryCalls = harness.faux.getCallLog().filter((c) => c.modelId === "faux-1").length;
		expect(primaryCalls).toBe(1);
		// Fallback's retry sleep has delayMs 0 (switchedFallback).
		expect(harness.eventsOfType("auto_retry_start").map((e) => e.delayMs)).toEqual([0]);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);

		// The primary should be suppressed (cooldown with remaining hint = 1_258_000ms).
		// Advance time past the 30s default rate-limit cooldown but NOT past 1_258_000ms.
		now += 60_000;
		await harness.session.prompt("again");
		// Primary should NOT have reverted — cooldown is 1_258_000ms.
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
	});

	// (5) Hint >= 3_600_000ms -> fallback, no probe arm (tier3).
	it("hint >= 3600s falls back immediately (tier3) with no probe scheduled", async () => {
		const now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(hint3600s), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		// Immediate fallback on first failure.
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);
		expect(harness.eventsOfType("auto_retry_start").map((e) => e.delayMs)).toEqual([0]);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);
		// Primary called exactly once.
		const primaryCalls = harness.faux.getCallLog().filter((c) => c.modelId === "faux-1").length;
		expect(primaryCalls).toBe(1);
	});

	// (6) Non-429 500 keeps today's exponential behavior (characterization).
	it("non-429 500 uses exponential backoff unchanged", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1000,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(transient500), fauxAssistantMessage("primary recovered")]);

		await harness.session.prompt("hello");

		// No fallback — exponential retry on same model.
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		// First retry delay = baseDelayMs * 2^0 = 1000.
		expect(harness.eventsOfType("auto_retry_start").map((e) => e.delayMs)).toEqual([1000]);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not tier-route a transient error with 429 only inside a request id", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1000,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			errorTurn("request req_429429429 failed with HTTP 500 socket timeout"),
			fauxAssistantMessage("primary recovered"),
		]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1000]);
		expect(harness.faux.getCallLog().filter((call) => call.modelId === "faux-1")).toHaveLength(2);
	});

	it("tier-routes an HTTP 429 rate limit control", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1000,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn("HTTP 429 rate limit"), fauxAssistantMessage("fallback recovered")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([0]);
		expect(harness.faux.getCallLog().filter((call) => call.modelId === "faux-1")).toHaveLength(1);
	});

	it("uses exponential backoff for a non-429 transient with an explicit zero hint", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1000,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			errorTurn("HTTP 500 internal_error (retry-after-ms: 0)"),
			fauxAssistantMessage("primary recovered"),
		]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1000]);
		expect(harness.faux.getCallLog().filter((call) => call.modelId === "faux-1")).toHaveLength(2);
	});

	// (7) Tier-2 fallback arms the probe scheduler (retry_probe_scheduled emitted with probeIndex 1).
	it("tier2 fallback emits retry_probe_scheduled with probeIndex 1", async () => {
		const now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(hint1258s), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		// Fallback was applied (tier2).
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);

		// Probe scheduler was armed — retry_probe_scheduled emitted with probeIndex 1.
		const scheduled = harness.eventsOfType("retry_probe_scheduled");
		expect(scheduled.length).toBeGreaterThanOrEqual(1);
		expect(scheduled[0]).toMatchObject({
			selector: primary,
			probeIndex: 1,
		});
		expect(scheduled[0].atMs).toBeGreaterThan(now);
	});
});
