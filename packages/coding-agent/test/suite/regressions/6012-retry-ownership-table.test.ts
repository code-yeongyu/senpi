import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { isTurnRetryableFailure } from "../../../src/core/turn-retry-eligibility.ts";
import {
	isRetryableProviderMessage,
	ProviderErrorPresentation,
} from "../../../src/modes/interactive/provider-error-presentation.ts";
import { providerErrorReason } from "../../../src/modes/interactive/provider-error-reason.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { assistantFailure } from "../provider-error-presentation-harness.ts";

const session = { model: { contextWindow: 200_000 } };
const NGINX_502 = "502 <html>\n<head><title>502 Bad Gateway</title></head>\n</html>";

describe("senpi#6012 a row folds into the retry episode only for a failure the engine retries", () => {
	it.each([
		[
			"a context overflow naming a 500 inside its token count",
			"400: prompt is too long: 250000 tokens > 200000 maximum",
		],
		[
			"a context overflow whose token count contains 500",
			"This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens.",
		],
		["a provider-suppressed replay of a 502 page", `senpi:no-turn-retry:${NGINX_502}`],
	])("keeps its own row: %s", (_name, errorMessage) => {
		const message = assistantFailure(errorMessage);
		expect(isTurnRetryableFailure(message, session.model.contextWindow)).toBe(false);
		expect(isRetryableProviderMessage(message, session)).toBe(false);
	});

	it("keeps the row of a local failure whose text reads like a 503", () => {
		const message = { ...assistantFailure("503 service unavailable"), failureSource: "local" as const };
		expect(isRetryableProviderMessage(message, session)).toBe(false);
	});

	it.each([
		["a gateway 429 JSON body", '429: {"type":"throttling_error","code":"429"}'],
		["an nginx 502 HTML page", NGINX_502],
		["a plain network drop", "fetch failed"],
	])("folds into the episode: %s", (_name, errorMessage) => {
		const message = assistantFailure(errorMessage);
		expect(isTurnRetryableFailure(message, session.model.contextWindow)).toBe(true);
		expect(isRetryableProviderMessage(message, session)).toBe(true);
	});
});

describe("senpi#6012 short failure reason", () => {
	it.each([
		['429: {"message":"litellm.RateLimitError"}', "429 rate limited"],
		[NGINX_502, "502 bad gateway"],
		["429 status code (no body)", "429 rate limited"],
		["503 Service Unavailable", "503 service unavailable"],
		[`senpi:no-turn-retry:${NGINX_502}`, "502 bad gateway"],
		["senpi:no-turn-retry:502 Bad Gateway", "502 bad gateway"],
		["500 tokens exceeded the limit", undefined],
		["prompt is too long: 250000 tokens > 200000 maximum", undefined],
		["fetch failed", "network error"],
	])("%j -> %j", (raw, reason) => {
		expect(providerErrorReason(raw)).toBe(reason);
	});

	it("a recovered episode does not lend its reason to a later unreadable failure", () => {
		initTheme("dark");
		const chat = new Container();
		const presentation = new ProviderErrorPresentation(chat);
		presentation.retrying('429: {"type":"throttling_error"}', false);
		presentation.clear();
		presentation.retrying("the provider closed the stream unexpectedly", false);
		presentation.finish("the provider closed the stream unexpectedly", 1);
		const rendered = chat.render(200).join("\n");
		expect(rendered).toContain("could not complete the request after 1 retries.");
		expect(rendered).not.toContain("429");
	});
});
