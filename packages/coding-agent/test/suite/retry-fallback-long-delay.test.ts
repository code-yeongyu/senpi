import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const second = "faux/faux-3";

// Fixtures must be BOTH retryable and parseable: a bare "retry after N seconds"
// string never reaches _handleRetryableError, because isRetryableAssistantError
// keys on the provider-error vocabulary (packages/ai/src/utils/retry.ts).
const overThreshold = "HTTP 429: rate_limit_exceeded - retry after 3600 seconds";
const underThreshold = "HTTP 429: rate_limit_exceeded - retry-after-ms: 5";
const transient = "overloaded_error";

function errorTurn(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("retry fallback for over-threshold provider delays", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("switches through the chain instead of failing the turn", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(overThreshold), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, chainKey: primary, reason: "transient" },
		]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([0]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("keeps the primary suppressed for the full provider-requested delay", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			errorTurn(overThreshold),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("still on the fallback"),
		]);

		await harness.session.prompt("hello");
		await harness.session.prompt("again");

		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
	});

	it("settles the turn unchanged when no chain is configured", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(overThreshold), fauxAssistantMessage("never reached")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		// The guard path deliberately stays asymmetric with the over-budget branch:
		// it reports the delay-cap failure and emits no exhaustion event.
		expect(harness.eventsOfType("retry_fallback_exhausted")).toEqual([]);
		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends.map((event) => event.success)).toEqual([false]);
		expect(ends[0]?.finalError).toContain("exceeding configured maximum");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("waits on the same model when the requested delay is within the cap", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(underThreshold), fauxAssistantMessage("primary recovered")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([5]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("hops once when an over-budget switch and an over-threshold delay collide", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback, second] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			errorTurn(transient),
			errorTurn(transient),
			errorTurn(transient),
			errorTurn(overThreshold),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		// The over-budget branch owns this switch; the delay guard must not hop again
		// on the same error and skip the first candidate's own retry budget.
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, chainKey: primary, reason: "transient" },
		]);
		expect(harness.faux.state.callCount).toBe(5);
	});

	it("terminates instead of looping once the chain is spent", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 6 }, () => errorTurn(overThreshold)));

		await harness.session.prompt("hello");

		// A spent chain must drive canTryFallback() false, or the new gate arm loops.
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
