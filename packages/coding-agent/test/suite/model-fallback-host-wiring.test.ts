import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import modelFallbackExtension from "../../src/core/extensions/builtin/model-fallback/index.ts";
import { renderFallbackState } from "../../src/core/extensions/builtin/model-fallback/ui.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

const billingError =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

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

	it("uses the first available candidate from the shipped Fable 5 chain", async () => {
		const harness = await createHarness({
			provider: "anthropic",
			models: [{ id: "claude-fable-5" }, { id: "claude-opus-5" }, { id: "claude-opus-4-8" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("use the default Fable fallback chain");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: "anthropic/claude-fable-5", to: "anthropic/claude-opus-5" },
		]);
	});

	it("makes a quick-set chain visible to the running retry engine", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 } },
			extensionFactories: [{ factory: modelFallbackExtension }],
		});
		harnesses.push(harness);
		const context = harness.getExtensionRunner().createCommandContext();

		expect(harness.settingsManager.getRawFallbackChains()).toBeUndefined();
		await getFallbackCommand(harness).handler(`${primary} ${fallback}`, context);
		// The quick-set chain is what must reach the engine; shipped defaults for
		// other models stay resolved alongside it.
		expect(harness.settingsManager.getRetryFallbackSettings().chains[primary]).toEqual([fallback]);

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

	it("exposes refusal pin state and badge semantics through the live menu accessor", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "refusal", stopDetails: { type: "refusal" } }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("create a refusal fallback");
		const context = harness.getExtensionRunner().createCommandContext();
		expect(context.sessionSettings.getFallbackStatus()?.pinned).toBe(true);
		expect(renderFallbackState(context, harness.settingsManager.getRetryFallbackSettings())).toContain("(pinned)");

		expect(
			(
				harness.session as unknown as { _retryFallback: { notifyCompactionApplied(): boolean } }
			)._retryFallback.notifyCompactionApplied(),
		).toBe(true);
		expect(context.sessionSettings.getFallbackStatus()?.pinned).toBe(false);
		expect(renderFallbackState(context, harness.settingsManager.getRetryFallbackSettings())).not.toContain(
			"(pinned)",
		);
	});

	it("keeps billing pins in the live status and badge after compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: billingError }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("create a billing fallback");
		const context = harness.getExtensionRunner().createCommandContext();
		expect(context.sessionSettings.getFallbackStatus()?.pinned).toBe(true);
		expect(renderFallbackState(context, harness.settingsManager.getRetryFallbackSettings())).toContain("(pinned)");
		expect(
			(
				harness.session as unknown as { _retryFallback: { notifyCompactionApplied(): boolean } }
			)._retryFallback.notifyCompactionApplied(),
		).toBe(false);
		expect(context.sessionSettings.getFallbackStatus()?.pinned).toBe(true);
		expect(renderFallbackState(context, harness.settingsManager.getRetryFallbackSettings())).toContain("(pinned)");
	});

	it("exposes active retry state through the live menu accessor", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [fallback] } },
			},
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

	it("restores the pre-fallback model for the current session on command", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [fallback] } },
			},
			extensionFactories: [{ factory: modelFallbackExtension }],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback response"),
		]);
		await harness.session.prompt("enter fallback");
		expect(harness.session.model?.id).toBe("faux-2");

		const context = harness.getExtensionRunner().createCommandContext();
		await getFallbackCommand(harness).handler("restore", context);

		expect(harness.session.model?.id).toBe("faux-1");
		expect(context.sessionSettings.getFallbackStatus()).toBeUndefined();
	});
});
