import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "other-faux/faux-2";
const MINUTE = 60_000;

// The Kakao report: a primary that keeps hitting a short session limit must come back at each reset,
// not slide onto a cooldown that doubles past the window with every failed retry (senpi#3314).
const SESSION_LIMIT =
	"Devin stream error resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 2 minutes.";

const limited = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: SESSION_LIMIT });

describe("a rate-limit fallback is retried at its reset window, not held for a doubling cooldown", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("#given a primary still limited at its first two resets #when the third reset passes #then the session is back on the primary", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		harness.setResponses([
			limited(),
			fauxAssistantMessage("fallback 1"),
			limited(),
			fauxAssistantMessage("fallback 2"),
			limited(),
			fauxAssistantMessage("fallback 3"),
			fauxAssistantMessage("primary answer"),
		]);

		for (const turn of ["one", "two", "three"]) {
			await harness.session.prompt(turn);
			now += 2.5 * MINUTE;
		}
		await harness.session.prompt("four");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual([
			"faux-1",
			"faux-2",
			"faux-1",
			"faux-2",
			"faux-1",
			"faux-2",
			"faux-1",
		]);
		expect(harness.session.model?.id).toBe("faux-1");
	});
});
