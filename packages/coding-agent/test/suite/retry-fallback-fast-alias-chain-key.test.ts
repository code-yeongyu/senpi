import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import serviceTierExtension from "../../src/core/extensions/builtin/service-tier.ts";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

const CODEX_PROVIDER = "chatgpt-subscription";
const BASE_ID = "gpt-6-luna";
const FAST_ID = `${BASE_ID}-fast`;
const FALLBACK_ID = "claude-haiku-5-5";
const BASE = `${CODEX_PROVIDER}/${BASE_ID}`;
const FAST = `${CODEX_PROVIDER}/${FAST_ID}`;
const FALLBACK = `my-proxy/${FALLBACK_ID}`;
const USAGE_LIMIT =
	"You have hit your ChatGPT usage limit (pro plan). Buy credits at https://chatgpt.com/settings/usage.";

/**
 * omo#12063: a session that starts on a `-fast` catalog alias runs on its base model (the
 * service-tier extension swaps it at session start and sends the priority tier instead), so a
 * chain keyed by the `-fast` selector it was started with must still govern the session.
 */
describe("a chain keyed by a -fast alias governs the base model the session runs on", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function startOnFastAlias(chainKey: string): Promise<Harness> {
		const harness = await createHarness({
			api: "openai-codex-responses",
			provider: CODEX_PROVIDER,
			models: [{ id: FAST_ID }, { id: BASE_ID }, { id: FALLBACK_ID }],
			upstreamModelId: BASE_ID,
			serviceTier: "priority",
			fallbackNow: () => 0,
			extensionFactories: [serviceTierExtension],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { [chainKey]: [FALLBACK] } },
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "my-proxy", [FALLBACK_ID]);
		await harness.session.bindExtensions({});
		return harness;
	}

	for (const chainKey of [FAST, BASE]) {
		it(`#given a chain keyed ${chainKey} #when the ChatGPT usage limit fails the turn #then the next rung answers`, async () => {
			const harness = await startOnFastAlias(chainKey);
			expect(harness.session.model?.id).toBe(BASE_ID);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT }),
				fauxAssistantMessage("fallback answer"),
			]);

			await harness.session.prompt("hello");

			expect({
				models: harness.faux.getCallLog().map((call) => call.modelId),
				applied: harness.eventsOfType("retry_fallback_applied").map((event) => [event.from, event.to]),
			}).toEqual({ models: [BASE_ID, FALLBACK_ID], applied: [[BASE, FALLBACK]] });
		});
	}
});
