import { describe, expect, it } from "vitest";
import {
	describeProviderFailureForUser,
	stripTurnRetrySuppressionPrefix,
} from "../src/utils/provider-failure-description.ts";

const MARKER = "senpi:no-turn-retry:";

describe("stripTurnRetrySuppressionPrefix", () => {
	it("removes the session-internal replay marker wherever it appears", () => {
		expect(stripTurnRetrySuppressionPrefix(`${MARKER}WebSocket error`)).toBe("WebSocket error");
		expect(stripTurnRetrySuppressionPrefix(`${MARKER}${MARKER}rate limited`)).toBe("rate limited");
		expect(stripTurnRetrySuppressionPrefix("plain")).toBe("plain");
	});
});

describe("describeProviderFailureForUser", () => {
	it("explains an abnormal WebSocket closure in plain language and names the next step", () => {
		const text = describeProviderFailureForUser("WebSocket closed 1006 Connection ended", {
			model: "openai-codex/gpt-6-astra",
			recovery: "no-fallback-configured",
		});
		expect(text).toBe(
			"The connection to the provider for openai-codex/gpt-6-astra dropped before the reply finished (WebSocket closed 1006 Connection ended). No fallback model is configured for it, so nothing could take the turn over: run /fallback to add one, or send the message again to continue from the partial reply.",
		);
	});

	it("never renders the internal marker, even when the transport fault came through a lane that stamps it", () => {
		const text = describeProviderFailureForUser(`${MARKER}WebSocket error`);
		expect(text).toBe(
			"The connection to the provider reported an error before the reply finished (WebSocket error).",
		);
		expect(text).not.toContain(MARKER);
	});

	it("counts the same-model attempts that already failed", () => {
		const text = describeProviderFailureForUser("WebSocket closed 1006 Connection ended", {
			attempts: 2,
			recovery: "chain-exhausted",
		});
		expect(text).toBe(
			"The connection to the provider dropped before the reply finished (WebSocket closed 1006 Connection ended). Retried 2 times on the same model with the same result. Every model in its fallback chain was tried as well: run /fallback to review the chain, or send the message again to continue from the partial reply.",
		);
	});

	it("describes a connect timeout", () => {
		expect(describeProviderFailureForUser("WebSocket connect timeout after 15000ms")).toBe(
			"The provider did not accept the connection within 15s.",
		);
	});

	it("delegates provider-stream stalls to the stall description", () => {
		expect(describeProviderFailureForUser("Idle timeout waiting for provider stream after 300000ms")).toBe(
			"The provider started the response and then went silent within 5m, so the request was cancelled.",
		);
	});

	it("returns undefined for failures it has no wording for", () => {
		expect(describeProviderFailureForUser("Codex error: stream ended with an error response")).toBeUndefined();
		expect(describeProviderFailureForUser(undefined)).toBeUndefined();
	});
});
