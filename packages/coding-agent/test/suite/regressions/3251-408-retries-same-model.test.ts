import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

function failure(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("a request timeout retries the same model before the fallback chain (senpi#3251)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function sessionWithFallback(): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		return harness;
	}

	it.each([
		"Upstream provider gateway returned 408 with no response body",
		"HTTP 408 Request Timeout",
		"read ECONNRESET",
	])("answers on the same model after two failures: %s", async (errorMessage) => {
		const harness = await sessionWithFallback();
		harness.setResponses([failure(errorMessage), failure(errorMessage), fauxAssistantMessage("answered")]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(`${harness.session.model?.provider}/${harness.session.model?.id}`).toBe("faux/faux-1");
	});

	it.each([
		"400 Bad Request: invalid parameter `foo`",
		"400 Bad Request: max_tokens must be <= 408",
		"HTTP 400 Bad Request: invalid parameter at position 408",
		"400 Bad Request: expected a status other than HTTP 408 Request Timeout",
	])("falls back without retrying the invalid request: %s", async (errorMessage) => {
		const harness = await sessionWithFallback();
		harness.setResponses([failure(errorMessage), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
	});
});
