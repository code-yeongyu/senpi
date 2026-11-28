import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { describeUsageLimitMessage } from "../../../src/core/retry-fallback/usage-limit.ts";
import { describedProviderError } from "../../../src/modes/interactive/provider-error-description.ts";

// senpi#5518: publishing a model-scoped refusal leaves the diagnostic intact for the transcript to format.
it("shows credit advice when the provider's refusal names a model", () => {
	const raw =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to use the claude-opus-5 model. Please go to Plans & Billing to purchase credits."}}';
	const message = {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: raw }),
		provider: "anthropic",
		model: "claude-opus-5",
	};
	const published = describeUsageLimitMessage(message);

	expect(published.errorCause).toEqual({ type: "usage_limit", scope: "model" });
	expect(published.errorMessage).toBe(raw);
	expect(describedProviderError(published)).toBe(
		"The anthropic account is out of credit for this model. Add credit to it, or choose another configured provider.",
	);
});
