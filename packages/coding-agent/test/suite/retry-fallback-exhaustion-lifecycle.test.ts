import { createHash } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function seedLiveContext(harness: Harness, tokens: number): void {
	const timestamp = Date.now();
	const primary = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "work already in progress" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "saved progress" }],
		api: primary.api,
		provider: primary.provider,
		model: primary.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function registerUnknownEvent(pi: object, eventName: string, handler: (event: unknown) => unknown): void {
	const register = Reflect.get(pi, "on");
	if (typeof register !== "function") throw new Error("missing extension event registration");
	Reflect.apply(register, pi, [eventName, handler]);
}

describe("retry fallback exhaustion lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("publishes context exhaustion from the real prompt lifecycle without calling the rejected model", async () => {
		// given
		const extensionEvents: unknown[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 80_000, maxTokens: 4_000 },
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
			extensionFactories: [
				(pi) => {
					registerUnknownEvent(pi, "retry_fallback_exhausted", (event) => extensionEvents.push(event));
				},
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 90_000);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "billing error: insufficient_quota",
			}),
		]);

		// when
		await harness.session.prompt("continue");
		await Promise.resolve();

		// then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(extensionEvents).toHaveLength(1);
		expect(extensionEvents).toMatchObject([
			{
				lastError: "billing error: insufficient_quota",
				lastErrorSha256: createHash("sha256").update("billing error: insufficient_quota").digest("hex"),
			},
		]);
		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([
			{ chainKey: "faux/faux-1", lastError: "billing error: insufficient_quota" },
		]);
	});
});
