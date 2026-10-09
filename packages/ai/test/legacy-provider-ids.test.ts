import { describe, expect, it } from "vitest";
import { isLegacyProviderId, normalizeModelRef, normalizeProviderId } from "../src/legacy-provider-ids.ts";

describe("legacy provider ids", () => {
	it("maps openai-codex to chatgpt-subscription", () => {
		expect(normalizeProviderId("openai-codex")).toBe("chatgpt-subscription");
	});

	it("maps claude-sdk-oauth to anthropic-subscription", () => {
		expect(normalizeProviderId("claude-sdk-oauth")).toBe("anthropic-subscription");
	});

	it("leaves anthropic unchanged", () => {
		expect(normalizeProviderId("anthropic")).toBe("anthropic");
	});

	it("leaves openai unchanged", () => {
		expect(normalizeProviderId("openai")).toBe("openai");
	});

	it("is idempotent for legacy and canonical ids", () => {
		for (const id of ["openai-codex", "claude-sdk-oauth", "anthropic"] as const) {
			expect(normalizeProviderId(normalizeProviderId(id))).toBe(normalizeProviderId(id));
		}
	});

	it("normalizes the provider half of a model ref", () => {
		expect(normalizeModelRef("openai-codex/gpt-5.6-sol")).toBe("chatgpt-subscription/gpt-5.6-sol");
	});

	it("keeps a model id containing a slash intact", () => {
		expect(normalizeModelRef("openai-codex/vendor/model-x")).toBe("chatgpt-subscription/vendor/model-x");
	});

	it("handles empty and slash-free refs without throwing", () => {
		expect(() => normalizeModelRef("")).not.toThrow();
		expect(() => normalizeModelRef("gpt-5.6-sol")).not.toThrow();
		expect(normalizeModelRef("")).toBe("");
		expect(normalizeModelRef("gpt-5.6-sol")).toBe("gpt-5.6-sol");
	});

	it("detects only the legacy provider ids", () => {
		expect(isLegacyProviderId("openai-codex")).toBe(true);
		expect(isLegacyProviderId("claude-sdk-oauth")).toBe(true);
		expect(isLegacyProviderId("anthropic")).toBe(false);
		expect(isLegacyProviderId("openai")).toBe(false);
		expect(isLegacyProviderId("unknown")).toBe(false);
	});
});
