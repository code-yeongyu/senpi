import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const LIMITED = "devin/swe-2-medium";
const FALLBACK = "devin/swe-2-high";
const FREE_LIMIT =
	"Devin stream error resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 9 minutes (at 16:56 UTC).";

const servedOnlyByFallback: FauxResponseStep = (_context, _options, _state, model) =>
	model.id === "swe-2-medium"
		? fauxAssistantMessage("", { stopReason: "error", errorMessage: FREE_LIMIT })
		: fauxAssistantMessage("served by the fallback model");

describe("senpi#2660: a model's free-tier limit moves the turn to the next model", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function devinSession(options: { nearCompactionThreshold: boolean; now?: () => number }): Promise<Harness> {
		const harness = await createHarness({
			provider: "devin",
			...(options.now === undefined ? {} : { fallbackNow: options.now }),
			models: [
				{ id: "swe-2-medium", contextWindow: 200_000, maxTokens: 16_384 },
				{ id: "swe-2-high", contextWindow: 200_000, maxTokens: 16_384 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16_384 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [LIMITED]: [FALLBACK] } },
			},
			extensionFactories: [compactionExtension],
		});
		harnesses.push(harness);
		if (options.nearCompactionThreshold) {
			const originalStream = harness.agent.streamFunction;
			let firstProviderCall = true;
			harness.agent.streamFunction = async (...args) => {
				if (firstProviderCall) {
					firstProviderCall = false;
					for (let index = 0; index < 46; index += 1) {
						harness.sessionManager.appendMessage({
							role: "user",
							content: [{ type: "text", text: `prior context ${index} `.repeat(1_000) }],
							timestamp: Date.now() - 2_000,
						});
					}
					harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
				}
				return originalStream(...args);
			};
		}
		harness.setResponses(Array.from({ length: 8 }, () => servedOnlyByFallback));
		return harness;
	}

	it("#given the user's pinned model reports its free limit #when the turn fails #then the next model in the user's chain answers, reported as a model usage limit", async () => {
		// given
		const harness = await devinSession({ nearCompactionThreshold: false });

		// when
		await harness.session.prompt("continue");

		// then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["swe-2-medium", "swe-2-high"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: LIMITED, to: FALLBACK, limit: "model" },
		]);
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "stop",
		});
	});

	it("#given the limit says it resets in 9 minutes #when the next prompts arrive #then the fallback model keeps serving until the window passes, then the primary returns", async () => {
		// given
		let now = 0;
		const harness = await devinSession({ nearCompactionThreshold: false, now: () => now });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: FREE_LIMIT }),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("still on the fallback"),
			fauxAssistantMessage("primary is back"),
		]);
		await harness.session.prompt("first");

		// when
		now += 5 * 60_000;
		await harness.session.prompt("second");
		const modelAfterFiveMinutes = harness.session.model?.id;
		now += 5 * 60_000;
		await harness.session.prompt("third");

		// then
		expect(modelAfterFiveMinutes).toBe("swe-2-high");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual([
			"swe-2-medium",
			"swe-2-high",
			"swe-2-high",
			"swe-2-medium",
		]);
	});

	it("#given a plain rate limit with no switch-model advice #when the turn fails #then it is not reported as a usage limit", async () => {
		// given
		const harness = await devinSession({ nearCompactionThreshold: false });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded, please slow down" }),
			fauxAssistantMessage("served on retry"),
		]);

		// when
		await harness.session.prompt("continue");

		// then
		const applied = harness.eventsOfType("retry_fallback_applied");
		expect(applied.map((event) => event.limit)).not.toContain("model");
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "stop",
		});
	});

	it("#given the context is near the compaction threshold #when the limited model fails #then the turn moves to the fallback model before any compaction and finishes there", async () => {
		// given
		const harness = await devinSession({ nearCompactionThreshold: true });

		// when
		await harness.session.prompt("continue");

		// then
		const calls = harness.faux.getCallLog().map((call) => call.modelId);
		expect(calls.filter((model) => model === "swe-2-medium")).toEqual(["swe-2-medium"]);
		expect(calls.at(-1)).toBe("swe-2-high");
		const order = harness.events
			.map((event) => event.type)
			.filter((type) => type === "compaction_start" || type === "retry_fallback_applied");
		expect(order[0]).toBe("retry_fallback_applied");
		expect(harness.eventsOfType("compaction_end").map((event) => event.accepted)).not.toContain(false);
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "stop",
		});
	});
});
