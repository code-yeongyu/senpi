import { describe, expect, it } from "vitest";
import { classifyErrorMessage, isQuotaExhaustionMessage } from "../src/utils/retry.ts";

// senpi#4632: a custom OpenAI-compatible gateway answered 503 with a body whose
// message merely mentions a billing lookup ("resolve Billing Scope: ... dial
// tcp: i/o timeout"). The bare word "billing" in the prose classified the
// transient 5xx as a billing / account-wide usage limit, so the turn never
// retried and the whole provider was held.
const billingScope503 =
	`opendesign API error (503): {"error":{"type":"server_error","code":"workspace_billing_scope_unavailable",` +
	`"message":"[code=workspace_billing_scope_unavailable] resolve Billing Scope: Get ` +
	`"https://amr-api.open-design.ai/api/internal/billing/scope/x": dial tcp: i/o timeout"}}`;

describe("503 whose body mentions billing (senpi#4632)", () => {
	it("classifies the Billing Scope 503 as retryable, not a quota exhaustion", () => {
		expect(classifyErrorMessage(billingScope503)).toBe("retryable");
		expect(isQuotaExhaustionMessage(billingScope503)).toBe(false);
	});

	it("keeps a genuine quota refusal terminal even on a 5xx status", () => {
		const quota503 =
			`gateway API error (503): {"error":{"type":"server_error","code":"insufficient_quota",` +
			`"message":"insufficient_quota: you exceeded your current quota"}}`;
		expect(classifyErrorMessage(quota503)).toBe("non-retryable");
		expect(isQuotaExhaustionMessage(quota503)).toBe(true);
	});

	it("keeps genuine 402/429 quota bodies terminal", () => {
		expect(
			classifyErrorMessage(
				`openai API error (429): {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}`,
			),
		).toBe("non-retryable");
		expect(
			isQuotaExhaustionMessage(
				`anthropic API error (429): {"error":{"type":"rate_limit_error","message":"credits_required: Usage credits are required for this model."}}`,
			),
		).toBe(true);
	});

	it("keeps bare billing prose terminal when no 5xx signal gates it", () => {
		expect(classifyErrorMessage("The account billing is exhausted; purchase credits to continue.")).toBe(
			"non-retryable",
		);
	});
});
