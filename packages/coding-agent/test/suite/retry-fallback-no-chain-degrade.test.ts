import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// A 429-class failure with NO usable fallback (no chain configured for the faux
// model) must degrade to in-turn same-model retries instead of dying instantly
// with "Retry failed after 0 attempts". Mirrors the real wafer incident shape:
// a 429 rate_limit_error (code server_overloaded) whose body carries no
// retry-after hint at all.
const noHint429 =
	'429: {"message":"The model is temporarily at capacity. Please retry shortly.","type":"rate_limit_error","param":null,"code":"server_overloaded"}';
// Hinted 429s land in tier2 (hint between cap and probe-back max) or tier3
// (hint >= probe-back max) via the canonical retry-after-ms marker.
const hint1258s = "HTTP 429: rate_limit_error (retry-after-ms: 1258000)";
const hint3600s = "HTTP 429: rate_limit_error (retry-after-ms: 3600000)";

function errorTurn(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("429 degrade to in-turn retry when fallback is unavailable", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("no-hint 429 without a chain retries in-turn with exponential backoff and recovers", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(noHint429), errorTurn(noHint429), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("hello");

		// No fallback exists, so no fallback events fire.
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		// Two in-turn retries with exponential delays (1ms, 2ms), then success.
		expect(harness.eventsOfType("auto_retry_start").map((e) => e.delayMs)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);
		// Initial call + two retries all reached the model.
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("no-hint 429 without a chain reports the true attempt count on exhaustion", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(noHint429), errorTurn(noHint429), errorTurn(noHint429)]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("auto_retry_start").map((e) => e.delayMs)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: 2, finalError: noHint429 },
		]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("tier2 hinted 429 without a chain waits in-turn clamped to hintedWaitCapMs", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					hintedWaitCapMs: 8,
					probeBackMaxMs: 3_600_000,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(hint1258s), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		// The 1258s hint is clamped to the 8ms in-turn cap instead of failing the turn.
		expect(harness.eventsOfType("auto_retry_start").map((e) => e.delayMs)).toEqual([8]);
		expect(harness.eventsOfType("auto_retry_end").map((e) => e.success)).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("tier3 hinted 429 without a chain fails fast but names the provider-requested wait", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(hint3600s)]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends).toMatchObject([{ success: false, attempt: 0 }]);
		// The terminal error must carry the provider-requested wait so the user
		// knows WHY the turn was not retried in-turn.
		expect(ends[0]?.finalError).toContain("3600s");
		expect(ends[0]?.finalError).toContain("rate_limit_error");
	});
});
