import { describe, expect, it } from "vitest";
import { isBillingErrorMessage } from "../../../src/core/retry-fallback/billing.ts";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";

// senpi#4632: a 503 whose body says "Billing Scope" (a billing-lookup timeout,
// not a spent account) must not become a billing failure or an account-wide
// usage limit, or the same-provider fallback rung is skipped as "account-limit"
// and the session stays dead until a manual /model change.
const billingScope503 =
	`opendesign API error (503): {"error":{"type":"server_error","code":"workspace_billing_scope_unavailable",` +
	`"message":"[code=workspace_billing_scope_unavailable] resolve Billing Scope: Get ` +
	`"https://amr-api.open-design.ai/api/internal/billing/scope/x": dial tcp: i/o timeout"}}`;

describe("503 whose body says Billing Scope (senpi#4632)", () => {
	it("is not a billing failure and carries no usage-limit scope", () => {
		expect(isBillingErrorMessage(billingScope503)).toBe(false);
		expect(usageLimitScope(billingScope503)).toBeUndefined();
	});

	it("keeps a genuine quota refusal billing-classed with account scope", () => {
		const quota = `openai API error (429): {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}`;
		expect(isBillingErrorMessage(quota)).toBe(true);
		expect(usageLimitScope(quota)).toBe("account");
	});

	it("keeps a 503 carrying an explicit quota code billing-classed", () => {
		const quota503 =
			`gateway API error (503): {"error":{"type":"server_error","code":"insufficient_quota",` +
			`"message":"insufficient_quota: you exceeded your current quota"}}`;
		expect(isBillingErrorMessage(quota503)).toBe(true);
		expect(usageLimitScope(quota503)).toBe("account");
	});
});
