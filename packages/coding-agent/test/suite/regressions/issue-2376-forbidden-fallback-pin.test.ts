import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Verbatim errors from the senpi#2376 incident session (2026-09-29).
const forbiddenError = '{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}';
// Billing scoped to one model (verbatim, 2026-07-29): the single faux provider stands in for
// the incident's second account, so the billing must not reach the original's account.
const creditsRequiredError =
	'429 event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required","model":"claude-fable-5"}},"request_id":"req_011CdW2nFxprAx6KQ9JhnAvq"}';

const forbidden = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: forbiddenError });
const targetBilling = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: creditsRequiredError });

describe("issue 2376: a transient forbidden rejection must not strand the session on a fallback", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("retries a forbidden-without-reason rejection on the same model before any fallback", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, fallbackChains: { "faux/faux-1": ["faux/faux-2"] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([forbidden(), fauxAssistantMessage("primary answered")]);

		await harness.session.prompt("hello");

		expect({
			calls: harness.faux.getCallLog().map((call) => call.modelId),
			fallbacks: harness.eventsOfType("retry_fallback_applied"),
			retries: harness.eventsOfType("auto_retry_start").length,
			model: harness.session.model?.id,
		}).toEqual({ calls: ["faux-1", "faux-1"], fallbacks: [], retries: 1, model: "faux-1" });
	});

	it("does not pin when a fallback target fails with billing, and returns to the original after the cooldown", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2", "faux/faux-3"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			forbidden(),
			forbidden(),
			targetBilling(),
			fauxAssistantMessage("third rung answered"),
			fauxAssistantMessage("original is back"),
		]);

		await harness.session.prompt("first");

		expect({
			reasons: harness.eventsOfType("retry_fallback_applied").map((event) => event.reason),
			model: harness.session.model?.id,
		}).toEqual({ reasons: ["transient", "billing"], model: "faux-3" });

		now += 10 * 60_000;
		await harness.session.prompt("second");

		expect({
			reverted: harness.eventsOfType("retry_fallback_reverted").map((event) => event.to),
			lastCall: harness.faux.getCallLog().at(-1)?.modelId,
			model: harness.session.model?.id,
		}).toEqual({ reverted: ["faux/faux-1"], lastCall: "faux-1", model: "faux-1" });
	});
});
