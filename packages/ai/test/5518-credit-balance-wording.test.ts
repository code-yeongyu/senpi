import { describe, expect, it } from "vitest";
import { describeProviderFailureForUser } from "../src/utils/provider-failure-description.ts";

const CREDIT_BALANCE =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

describe("an out-of-credit refusal is not worded as a usage limit (senpi#5518)", () => {
	it("names the empty credit balance and its remedy", () => {
		const text = describeProviderFailureForUser(CREDIT_BALANCE, {
			model: "anthropic/claude-opus-5",
			usageLimit: "account",
		});

		expect(text).toBe(
			"The anthropic account is out of credit. Add credit to it, or choose another configured provider.",
		);
	});

	it.each([
		"insufficient_quota: You exceeded your current quota, please check your plan and billing details.",
		"402 Payment Required: credits are required to use this model",
	])("words other credit exhaustion the same way: %s", (raw) => {
		expect(describeProviderFailureForUser(raw, { model: "openai/gpt-6", usageLimit: "account" })).toContain(
			"account is out of credit",
		);
	});

	it("keeps the usage-limit wording for a real usage limit (control)", () => {
		expect(
			describeProviderFailureForUser("You've hit your weekly limit · resets Mon 9am", {
				model: "anthropic-subscription/claude-opus-5",
				usageLimit: "account",
			}),
		).toContain("account usage limit has been reached (resets Mon 9am)");
	});
});
