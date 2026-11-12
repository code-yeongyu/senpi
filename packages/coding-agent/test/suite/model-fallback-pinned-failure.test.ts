import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// omo#13243: a turn that fails on a pinned model ends with the typed report a spent chain gives, naming the model.
const primary = "faux/faux-1";
const fallback = "faux/faux-2";

describe("a pinned model's failure is reported as a typed exhaustion (omo#13243)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("names the pinned model and its error when fallback is off", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					maxRetries: 0,
					modelFallback: false,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("stay pinned");

		expect(harness.eventsOfType("retry_fallback_applied")).toStrictEqual([]);
		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([
			{
				chainKey: primary,
				pinned: true,
				lastError: "overloaded_error",
				failures: [{ model: primary, error: "overloaded_error" }],
			},
		]);
	});

	it("reports nothing extra for a session whose fallback is on but has no chain", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [] } } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("no chain");

		expect(harness.eventsOfType("retry_fallback_exhausted")).toStrictEqual([]);
	});
});
