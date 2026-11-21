import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_SWITCH_MARKER_TYPE } from "../../src/core/model-switch-marker.ts";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

// omo#13243: a fallback switch is written where the model reads it.
const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const fallbackSettings = {
	retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [fallback] } },
};

function markerTexts(harness: Harness): string[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "custom" &&
		message.customType === MODEL_SWITCH_MARKER_TYPE &&
		typeof message.content === "string"
			? [message.content]
			: [],
	);
}

describe("model fallback switch marker (omo#13243)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("tells the model on its next request that another model now answers", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("fall back when the first model is overloaded");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: primary, to: fallback }]);
		const markers = markerTexts(harness);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toContain(`${primary} failed`);
		expect(markers[0]).toContain(`written by ${fallback}`);
		// The note sits in the context before the reply the fallback model wrote, so that request carried it.
		const markerIndex = harness.session.messages.findIndex(
			(message) => message.role === "custom" && message.customType === MODEL_SWITCH_MARKER_TYPE,
		);
		const replyIndex = harness.session.messages.findIndex(
			(message) => message.role === "assistant" && message.stopReason !== "error",
		);
		expect(markerIndex).toBeGreaterThanOrEqual(0);
		expect(replyIndex).toBeGreaterThan(markerIndex);
		const reply = harness.session.messages[replyIndex];
		if (reply?.role !== "assistant") throw new Error("expected the recovered reply");
		expect(`${reply.provider}/${reply.model}`).toBe(fallback);
	});
	it("writes a note queued while idle before a turn an extension message starts", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("woken")]);
		await harness.session.prompt("first turn");
		const fallbackModel = harness.getModel("faux-2");
		if (!fallbackModel) throw new Error("Missing faux-2");
		// The retry controller's own switch callback, run while the session is idle (a revert after compaction does this).
		await (
			harness.session as unknown as {
				_retryFallback: {
					deps: {
						switchModel(model: unknown, thinking: string, reason: "fallback" | "fallback-revert"): Promise<void>;
					};
				};
			}
		)._retryFallback.deps.switchModel(fallbackModel, "off", "fallback");

		await harness.session.sendCustomMessage(
			{ customType: "extension_wake", content: "wake up", display: false },
			{ triggerTurn: true },
		);
		await harness.session.waitForSettledSessionWork();

		const request = harness.faux.getCallLog().at(-1);
		if (!request) throw new Error("Missing the woken request");
		expect(JSON.stringify(request.context.messages)).toContain(`moved this session to ${fallback}`);
	});
	it("writes the note for a switch made at the turn start before that turn's request", async () => {
		const accountLimit =
			'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit }),
			fauxAssistantMessage("answered by the spare account"),
		]);
		// The first turn spends the account; no other provider serves yet, so it ends on the limit.
		await harness.session.prompt("first turn");
		registerFallbackModels(harness, "spare", ["faux-2"]);
		harness.settingsManager.applyOverrides({ retry: { fallbackChains: { [primary]: ["spare/faux-2"] } } });

		// The next turn starts on the spent account and is routed to the spare before its request.
		await harness.session.prompt("second turn");

		const request = harness.faux.getCallLog().at(-1);
		if (!request) throw new Error("Missing the routed request");
		expect(request.modelId).toBe("faux-2");
		expect(JSON.stringify(request.context.messages)).toContain("moved this session to spare/faux-2");
	});
});
