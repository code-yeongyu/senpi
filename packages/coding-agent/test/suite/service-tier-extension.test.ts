import { describe, expect, it } from "vitest";
import { addServiceTierToPayload, type ServiceTier } from "../../src/core/extensions/builtin/service-tier.js";

describe("service-tier builtin extension", () => {
	it("leaves payload unchanged when service tier is unset", () => {
		// given
		const payload = {
			model: "gpt-5",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, undefined);

		// then
		expect(result).toBe(payload);
	});

	it("injects service_tier for openai responses payloads when configured", () => {
		// given
		const payload = {
			model: "gpt-5",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, "priority") as {
			service_tier?: ServiceTier;
		};

		// then
		expect(result.service_tier).toBe("priority");
	});

	it("leaves incompatible api payloads unchanged", () => {
		// given
		const payload = {
			model: "claude-sonnet-4-5",
		};

		// when
		const result = addServiceTierToPayload("anthropic-messages", payload, "priority");

		// then
		expect(result).toBe(payload);
	});

	it("preserves explicit service_tier values already present on the payload", () => {
		// given
		const payload = {
			model: "gpt-5",
			service_tier: "flex",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, "priority");

		// then
		expect(result).toBe(payload);
	});
});
