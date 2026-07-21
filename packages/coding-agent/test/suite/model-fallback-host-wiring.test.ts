import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import modelFallbackExtension from "../../src/core/extensions/builtin/model-fallback/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

function getFallbackCommand(harness: Harness) {
	const command = harness.getExtensionRunner().getCommand("fallback");
	if (!command) throw new Error("Fallback command was not registered");
	return command;
}

describe("model fallback host wiring", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("makes a quick-set chain visible to the running retry engine", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1 } },
			extensionFactories: [{ factory: modelFallbackExtension }],
		});
		harnesses.push(harness);
		const context = harness.getExtensionRunner().createCommandContext();

		expect(harness.settingsManager.getRetryFallbackSettings().chains).toEqual({});
		await getFallbackCommand(harness).handler(`${primary} ${fallback}`, context);
		expect(harness.settingsManager.getRetryFallbackSettings().chains).toEqual({ [primary]: [fallback] });

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("retry with the chain written above");
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: primary, to: fallback }]);
	});

	it("applies the flag and environment escape hatches as session-only overrides", async () => {
		const flagHarness = await createHarness({
			settings: { retry: { modelFallback: true } },
			extensionFactories: [{ factory: modelFallbackExtension }],
			extensionFlagValues: new Map([["no-model-fallback", true]]),
		});
		harnesses.push(flagHarness);
		expect(flagHarness.settingsManager.getRetryFallbackSettings().modelFallback).toBe(false);

		const previous = process.env.SENPI_NO_FALLBACK;
		process.env.SENPI_NO_FALLBACK = "1";
		try {
			const environmentHarness = await createHarness({ settings: { retry: { modelFallback: true } } });
			harnesses.push(environmentHarness);
			expect(environmentHarness.settingsManager.getRetryFallbackSettings().modelFallback).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.SENPI_NO_FALLBACK;
			else process.env.SENPI_NO_FALLBACK = previous;
		}
	});

	it("exposes active retry state through the live menu accessor", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("create an active fallback");

		expect(harness.getExtensionRunner().createContext().sessionSettings.getFallbackStatus()).toEqual({
			active: true,
			currentModel: fallback,
			originalSelector: primary,
			pinned: false,
		});
	});
});
