import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { KIMI_CODE_RETRY_PROFILE } from "@earendil-works/pi-ai/utils/retry-profile/profiles";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

describe("retry profile routing", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("kimi profile (after-turn-budget): 429s spend the full same-model budget before fallback", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			retryProfile: KIMI_CODE_RETRY_PROFILE,
			settings: {
				retry: {
					enabled: true,
					fallbackChains: { [primary]: [fallback] },
					// Global retry.maxRetries/baseDelayMs are ignored once the provider
					// declares a profile; speed the test up through the per-provider
					// override instead. maxRetries is deliberately NOT overridden so the
					// 9-retry budget under test comes from the kimi profile itself.
					providers: {
						faux: { turn: { baseDelayMs: 1 } },
					},
				},
			},
		});
		harnesses.push(harness);

		const rateLimited = () =>
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "rate_limit_exceeded: All tokens rate limited",
			});
		// 10 failures exhaust the 9-retry budget; the 11th call (fallback) succeeds.
		harness.setResponses([
			rateLimited(),
			rateLimited(),
			rateLimited(),
			rateLimited(),
			rateLimited(),
			rateLimited(),
			rateLimited(),
			rateLimited(),
			rateLimited(),
			rateLimited(),
			fauxAssistantMessage("fallback recovered"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(11);
		const fallbackEvents = harness.eventsOfType("retry_fallback_applied");
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0]?.to).toBe(fallback);
	});

	it("senpi-default (tiered): first hint-less 429 falls back immediately", async () => {
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
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "rate_limit_exceeded: All tokens rate limited",
			}),
			fauxAssistantMessage("fallback recovered"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(2);
		const fallbackEvents = harness.eventsOfType("retry_fallback_applied");
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0]?.to).toBe(fallback);
	});

	it("kimi profile: uncapped server hint bypasses the over-ceiling gate", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			retryProfile: KIMI_CODE_RETRY_PROFILE,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "rate_limit_exceeded: retry-after-ms: 3600000",
			}),
			fauxAssistantMessage("recovered after long wait"),
		]);

		const promptPromise = harness.session.prompt("hello");

		// Subscribe to auto_retry_start and abort immediately after observing the delay.
		const retryStarts: Array<{ delayMs: number }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				retryStarts.push({ delayMs: event.delayMs });
				harness.session.abort();
			}
		});

		await promptPromise.catch(() => {});
		unsubscribe();

		expect(retryStarts).toHaveLength(1);
		expect(retryStarts[0]?.delayMs).toBe(3_600_000);
	});
});
