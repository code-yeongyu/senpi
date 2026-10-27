import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

const primary = "faux/faux-1";
const fallback = "other-faux/faux-2";

// The plan does not include the model: billing on the original's account, so the fallback pins.
const usageNotIncluded = () =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage:
			'429 {"error":{"type":"usage_not_included","message":"This model is not included in your current plan"}}',
	});

async function createChainHarness(): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: () => 0,
		settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
	});
	registerFallbackModels(harness, "other-faux", ["faux-2"]);
	return harness;
}

const calledModels = (harness: Harness) => harness.faux.getCallLog().map((call) => call.modelId);

describe("a re-login releases a billing-pinned fallback (senpi#4099)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("tries the original again on the next turn after its credential is replaced", async () => {
		const harness = await createChainHarness();
		harnesses.push(harness);
		harness.setResponses([usageNotIncluded(), fauxAssistantMessage("fallback"), fauxAssistantMessage("primary")]);

		await harness.session.prompt("first");
		expect(harness.session.model?.id).toBe("faux-2");

		harness.authStorage.set("faux", { type: "api_key", key: "synthetic-relogin-key" });
		await harness.session.prompt("second");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", "faux-1"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(1);
	});

	it("keeps the pin when only another provider's credential changes", async () => {
		const harness = await createChainHarness();
		harnesses.push(harness);
		harness.setResponses([usageNotIncluded(), fauxAssistantMessage("fallback"), fauxAssistantMessage("fallback")]);

		await harness.session.prompt("first");
		harness.authStorage.set("other-faux", { type: "api_key", key: "synthetic-other-key" });
		await harness.session.prompt("second");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
	});

	it("falls back and pins again when the new credential is still not entitled", async () => {
		const harness = await createChainHarness();
		harnesses.push(harness);
		harness.setResponses([
			usageNotIncluded(),
			fauxAssistantMessage("fallback"),
			usageNotIncluded(),
			fauxAssistantMessage("fallback again"),
			fauxAssistantMessage("still fallback"),
		]);

		await harness.session.prompt("first");
		harness.authStorage.set("faux", { type: "api_key", key: "synthetic-relogin-key" });
		await harness.session.prompt("second");
		// No further credential change: the fresh pin holds, so the dead original costs one request per re-login.
		await harness.session.prompt("third");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", "faux-1", "faux-2", "faux-2"]);
		expect(harness.session.model?.id).toBe("faux-2");
	});
});
