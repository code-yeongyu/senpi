import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

/**
 * The two agent-loop stream watchdog wordings. Both are ordinary retryable
 * provider failures: `isRetryableErrorMessage` already classifies them
 * transient, so they must consume the same bounded same-model retry budget
 * (`settings.retry.maxRetries`) as every other transient class before the
 * fallback chain is consulted.
 *
 * Reported by the session owner (2026-08-13) as
 * `Retry failed after 1 attempts: Provider stream start timed out after 30000ms`:
 * the stall-specific escalation surrendered the turn after a single same-model
 * probe while the configured budget was 3.
 */
const IDLE_STALL_ERROR = "Idle timeout waiting for provider stream after 300000ms";
const STREAM_START_STALL_ERROR = "Provider stream start timed out after 90000ms";

describe("provider stream stalls use the shared bounded retry budget", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each([
		["idle-timeout", IDLE_STALL_ERROR],
		["stream-start-timeout", STREAM_START_STALL_ERROR],
	])(
		"spends the full same-model budget on consecutive %s stalls before falling back",
		async (_wording, stallError) => {
			const harness = await createHarness({
				models: [{ id: "faux-1" }, { id: "faux-2" }],
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
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: stallError }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: stallError }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: stallError }),
				fauxAssistantMessage("primary recovered"),
			]);

			await harness.session.prompt("hello");

			// Three same-model attempts with the shared exponential backoff, and no
			// escalation: the stall class no longer short-circuits the budget.
			expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1, 2, 4]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
			expect(harness.faux.state.callCount).toBe(4);
		},
	);

	it("escalates to the fallback chain only after the shared budget is exhausted", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_START_STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_START_STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_START_STALL_ERROR }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		// maxRetries=2 same-model attempts, then the chain — the same arithmetic
		// every other transient class already follows.
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, chainKey: primary, reason: "transient" },
		]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("reports the exhausted budget instead of surrendering after one attempt when no chain exists", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_START_STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_START_STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_START_STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_START_STALL_ERROR }),
		]);

		await harness.session.prompt("hello");

		// The user-visible defect: this used to stop at 2 provider calls and
		// surface "Retry failed after 1 attempts".
		expect(harness.faux.state.callCount).toBe(4);
		expect(
			harness.eventsOfType("auto_retry_end").map((event) => ({
				success: event.success,
				attempt: event.attempt,
			})),
		).toEqual([{ success: false, attempt: 3 }]);
	});
});
