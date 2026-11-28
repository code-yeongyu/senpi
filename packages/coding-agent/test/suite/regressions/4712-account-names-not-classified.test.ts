import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AllAccountsBlockedError } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { allAccountsBlockedGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/guidance.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import { isBillingErrorMessage } from "../../../src/core/retry-fallback/billing.ts";
import { limitResetAt } from "../../../src/core/retry-fallback/limit-reset.ts";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness } from "../harness.ts";

// senpi#4712: only the account name varies, not what the pool knows about its failure.
it.each([
	"primary",
	"billing-team",
	"quota-weekly-limit",
	"quota weekly limit",
	"opus-only",
	"Opus weekly limit",
	"credit-balance insufficient_quota purchase credits credits-required credits are required",
	"usage_limit_reached usage_not_included usage limit has been reached",
	"billing premium sonnet haiku fable mythos model",
	"primary\n  status 503: overloaded\n  billing",
])("keeps a pool auth refusal a hard error with account %j", async (name) => {
	const errorMessage = allAccountsBlockedGuidance(undefined, "auth_error", [
		{ name, reason: "auth_error", until: undefined },
		{ name: "backup", reason: "auth_error", until: undefined },
	]);
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		settings: {
			retry: {
				enabled: true,
				maxRetries: 0,
				fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
			},
		},
	});
	try {
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("Fallback answered"),
		]);

		await harness.session.prompt("hello");

		expect(errorMessage).toContain(`  ${name}: auth_error`);
		expect({
			billing: isBillingErrorMessage(errorMessage),
			scope: usageLimitScope(errorMessage),
			switches: harness.eventsOfType("retry_fallback_applied").map(({ reason, limit }) => ({ reason, limit })),
		}).toEqual({
			billing: false,
			scope: undefined,
			switches: [{ reason: "hard-error", limit: undefined }],
		});
	} finally {
		harness.cleanup();
	}
});

it("keeps the real model scope and reset on an all-blocked refusal", () => {
	const now = Date.UTC(2026, 10, 22, 12);
	const until = now + 10 * 60_000;
	const error = new AllAccountsBlockedError(until, undefined, "claude-opus-4-5", undefined, [
		{ name: "billing-team", reason: "rate_limit", until },
	]);
	const errorMessage = withAuthGuidance(error, error.message, undefined, now);

	expect(errorMessage).toContain("billing-team");
	expect({
		billing: isBillingErrorMessage(errorMessage),
		scope: usageLimitScope(errorMessage),
		reset: limitResetAt({ errorMessage }, now),
	}).toEqual({ billing: false, scope: "model", reset: until });
});
