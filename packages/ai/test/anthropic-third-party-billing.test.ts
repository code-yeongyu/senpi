import { describe, expect, it } from "vitest";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { describeProviderFailureForUser } from "../src/utils/provider-failure-description.ts";
import { classifyErrorMessage, isQuotaExhaustionMessage } from "../src/utils/retry.ts";

// senpi#3259: Anthropic rejects a Claude subscription token sent straight to the Messages API with
// a permanent 400 that bills the request to "extra usage". Wire body as reported (request id redacted).
const THIRD_PARTY_400 =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_redacted"}';

describe("Anthropic third-party billing rejection (#3259)", () => {
	it("is terminal account exhaustion, never a retryable failure", () => {
		expect(classifyErrorMessage(THIRD_PARTY_400)).toBe("non-retryable");
		expect(isQuotaExhaustionMessage(THIRD_PARTY_400)).toBe(true);
	});

	it("names the billing path and the fix on the direct anthropic provider", () => {
		const text = describeProviderFailureForUser(THIRD_PARTY_400, {
			model: "anthropic/claude-opus-5-5",
			usageLimit: "account",
		});
		expect(text).toContain("/login");
		expect(text).toContain("https://claude.ai/settings/usage");
	});

	it("does not send a subscription user back to /login when the request already used the subscription lane", () => {
		const text = describeProviderFailureForUser(THIRD_PARTY_400, {
			model: "anthropic-subscription/claude-opus-5-5",
			usageLimit: "account",
		});
		expect(text).toContain("https://claude.ai/settings/usage");
		expect(text).not.toContain("/login");
	});

	it("offers no Claude subscription OAuth login on the direct anthropic provider", () => {
		const provider = anthropicProvider();
		expect(provider.auth.oauth).toBeUndefined();
		expect(provider.auth.apiKey).toBeDefined();
	});
});
