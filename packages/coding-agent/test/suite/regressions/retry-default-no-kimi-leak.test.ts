import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Phase-2 guardrail (plan todo 18): the shipped `senpi-default` profile runs with
// the phase-2 turn backoff values (8s per-attempt cap, additive 25% jitter) and must
// NOT acquire kimi-code semantics — no same-model 429 budget, no uncapped local wait,
// no unpinned billing fallback, no retry surviving an abort. Randomness is injected
// deterministically through the harness `retryRandom` seam so jittered local waits are
// exact; provider-derived waits and the fallback switch stay unjittered by contract.

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

// Both retryable AND rate-limit marked, so the 429-class tier router fires.
const noHint429 = "HTTP 429: rate_limit_exceeded - All tokens rate limited";
// 1_258_000ms sits above hintedWaitCapMs (300_000) and below probeBackMaxMs
// (3_600_000) => tier2: fallback now, probe the demoted model back later.
const hint1258s = "HTTP 429: rate_limit_error (retry-after-ms: 1258000)";
// Verbatim Anthropic Console credit exhaustion (429 carrying credits_required).
const billing429 =
	'429 event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required","model":"claude-fable-5"}},"request_id":"req_011CdW2nFxprAx6KQ9JhnAvq"}';
const transient500 = "HTTP 500: internal_error";

function errorTurn(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

function createDefaultProfileHarness(options: {
	now: () => number;
	baseDelayMs?: number;
	withChain?: boolean;
}): Promise<Harness> {
	return createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: options.now,
		// Midpoint sample: a jittered local wait is exactly floor * 1.125.
		retryRandom: () => 0.5,
		settings: {
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: options.baseDelayMs ?? 1,
				...(options.withChain === false ? {} : { fallbackChains: { [primary]: [fallback] } }),
			},
		},
	});
}

function primaryCallCount(harness: Harness): number {
	return harness.faux.getCallLog().filter((call) => call.modelId === "faux-1").length;
}

describe("senpi-default retry profile does not leak kimi-code semantics", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// (1) Mutation target: flipping fallback.rateLimited to "after-turn-budget"
	// spends the same-model turn budget first, which this scenario forbids.
	it("falls back on the first no-hint 429 with zero same-model retries", async () => {
		const harness = await createDefaultProfileHarness({ now: () => 0 });
		harnesses.push(harness);
		harness.setResponses([errorTurn(noHint429), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		// Kimi semantics would retry faux-1 up to the turn budget before switching.
		expect(primaryCallCount(harness)).toBe(1);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);
		// The fallback switch is the exact zero-delay contract: never jittered, never capped.
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([0]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	// (2) A huge hint must never become a same-model sleep; senpi tiers out instead.
	it("routes a 1258s hint to a tier2 fallback with probe-back, never an uncapped same-model wait", async () => {
		let now = 0;
		const harness = await createDefaultProfileHarness({ now: () => now });
		harnesses.push(harness);
		harness.setResponses([errorTurn(hint1258s), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		expect(primaryCallCount(harness)).toBe(1);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "transient" },
		]);
		// Only the zero-delay fallback switch: no 1_258_000ms (or any hint-derived) sleep.
		const delays = harness.eventsOfType("auto_retry_start").map((event) => event.delayMs);
		expect(delays).toEqual([0]);
		expect(delays).not.toContain(1_258_000);
		// Probe-back is armed at half the hint, bounded by the hint deadline.
		expect(harness.eventsOfType("retry_probe_scheduled")).toMatchObject([
			{ selector: primary, atMs: 629_000, probeIndex: 1 },
		]);
		// The demoted primary stays on cooldown for the full remaining hint: a
		// 60s hop past the generic 30s rate-limit cooldown must not revert it.
		now += 60_000;
		await harness.session.prompt("again");

		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
	});

	// (3) Billing-class 429 pins; a cooldown expiry must not walk back into a dead model.
	it("pins the fallback for a billing-class 429 instead of reverting on cooldown expiry", async () => {
		let now = 0;
		const harness = await createDefaultProfileHarness({ now: () => now });
		harnesses.push(harness);
		harness.setResponses([
			errorTurn(billing429),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("still fallback"),
		]);

		await harness.session.prompt("first");

		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual(["billing"]);
		expect(harness.session.model?.id).toBe("faux-2");

		// Past every cooldown bucket, including the 30-minute billing one.
		now += 31 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-2"]);
	});

	// (4) Abort during a local backoff sleep is terminal: one cancelled end, no further call.
	it("cancels a backoff sleep on abort with exactly one 'Retry cancelled' end and no further call", async () => {
		// No chain, non-429 transient: the retry stays on faux-1 and sleeps the
		// locally computed jittered wait (2000 * 1.125 = 2250ms) we abort inside.
		const harness = await createDefaultProfileHarness({ now: () => 0, baseDelayMs: 2_000, withChain: false });
		harnesses.push(harness);
		harness.setResponses([errorTurn(transient500), fauxAssistantMessage("must never be requested")]);

		let abortPromise: Promise<void> | undefined;
		const sawRetryStart = new Promise<{ delayMs: number }>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "auto_retry_start") return;
				unsubscribe();
				abortPromise = harness.session.abort();
				resolve({ delayMs: event.delayMs });
			});
		});

		const promptPromise = harness.session.prompt("hello");
		const retryStart = await sawRetryStart;
		if (!abortPromise) throw new Error("abort was not triggered from auto_retry_start");
		await abortPromise;
		await promptPromise;

		// Local exponential under phase-2 values: floor 2000, additive jitter at random 0.5.
		expect(retryStart.delayMs).toBe(2_250);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
		// The pending success response was never consumed: no post-abort provider call.
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
	});
});
