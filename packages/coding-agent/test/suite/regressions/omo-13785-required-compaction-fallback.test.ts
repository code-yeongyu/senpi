import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_COMPACTION_ERROR_MESSAGE } from "../../../src/core/required-compaction-error.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("required compaction failure ownership (oh-my-openagent#13785)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("does not switch models when required tool-continuation compaction is rejected", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "primary", contextWindow: 10_000, maxTokens: 512 },
				{ id: "fallback", contextWindow: 1_000_000, maxTokens: 512 },
			],
			settings: {
				compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 0 },
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/primary": ["faux/fallback"] },
				},
			},
			tools: [
				{
					name: "large_result",
					label: "Large result",
					description: "Return a synthetic context larger than the primary window",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "synthetic context ".repeat(10_000) }],
						details: {},
					}),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "deterministic compaction rejection",
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("large_result", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not use another model to bypass compaction"),
		]);

		// when
		await harness.session.prompt("read the synthetic large result");
		await harness.session.waitForSettledSessionWork();

		// then
		expect(harness.eventsOfType("compaction_end")).toContainEqual(expect.objectContaining({ accepted: false }));
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary"]);
		expect(harness.session.model?.id).toBe("primary");
		expect(harness.eventsOfType("agent_end")).toContainEqual(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({ stopReason: "error", errorMessage: REQUIRED_COMPACTION_ERROR_MESSAGE }),
				]),
			}),
		);
	});
});
