import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

/**
 * Routing coverage for the stream throughput watchdog (#1739).
 *
 * A provider that keeps answering at ~2 tok/s is not wedged, so replaying the
 * same payload on the same model cannot raise its rate: the throughput-degraded
 * class skips the same-model retry budget entirely and consults the fallback
 * chain immediately. With no chain, the turn ends with the measured rate in the
 * user-visible error instead of sitting on the trickle.
 */

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

/** 24 four-character deltas at 2 tok/s: one delta every 500ms for 12s. */
const SLOW_ANSWER = "word".repeat(24);

const throughputSettings = {
	minThroughputTokensPerSecond: 8,
	throughputWindowMs: 8_000,
	throughputGraceMs: 0,
};

function calledModelIds(harness: Harness): string[] {
	return harness.faux.getCallLog().map((entry) => entry.modelId);
}

function failedAssistantErrors(harness: Harness): string[] {
	return harness.session.messages
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.map((message) => message.errorMessage)
		.filter((errorMessage): errorMessage is string => errorMessage !== undefined);
}

describe("throughput-degraded streams skip same-model retries and fall back", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("applies the fallback chain after a single crawling attempt", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			tokensPerSecond: 2,
			tokenSize: { min: 1, max: 1 },
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
					provider: throughputSettings,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(SLOW_ANSWER), fauxAssistantMessage("ok")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, chainKey: primary, reason: "transient" },
		]);
		// The crawling model is asked exactly once: no same-model retry burn.
		expect(calledModelIds(harness)).toEqual(["faux-1", "faux-2"]);
		expect(getAssistantTexts(harness).join("\n")).toContain("ok");
	});

	it("ends the turn with the measured rate when no fallback model exists", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			tokensPerSecond: 2,
			tokenSize: { min: 1, max: 1 },
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					modelFallback: false,
					provider: throughputSettings,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(SLOW_ANSWER), fauxAssistantMessage("never reached")]);

		await harness.session.prompt("hello");

		expect(calledModelIds(harness)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(failedAssistantErrors(harness).join("\n")).toMatch(
			/Provider stream throughput degraded: \d+(?:\.\d+)? tok\/s over 8s \(floor 8 tok\/s\)/,
		);
		expect(harness.eventsOfType("stream_throughput_degraded")).toMatchObject([
			{ model: primary, chainConfigured: false },
		]);
	});
});
