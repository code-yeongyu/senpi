import { describe, expect, it } from "vitest";
import { legacyProviderIdRejection } from "../src/legacy-provider-ids.ts";

// Todo 9 (senpi#1989): a TYPED legacy provider id is rejected with a message
// that NAMES the new id. Ids read from disk are normalized instead (todo 8).
describe("typed legacy provider id rejection (senpi#1989)", () => {
	it("names both the old and the new id for each renamed provider", () => {
		const codex = legacyProviderIdRejection("openai-codex");
		expect(codex).toContain("openai-codex");
		expect(codex).toContain("chatgpt-subscription");
		const claude = legacyProviderIdRejection("claude-sdk-oauth");
		expect(claude).toContain("claude-sdk-oauth");
		expect(claude).toContain("anthropic-subscription");
	});

	it("rejects the legacy DISPLAY NAMES, which are typed surfaces too", () => {
		expect(legacyProviderIdRejection("OpenAI Codex")).toContain("chatgpt-subscription");
		expect(legacyProviderIdRejection("Claude SDK OAuth")).toContain("anthropic-subscription");
	});

	it("is case- and whitespace-insensitive the way a typed argument is", () => {
		expect(legacyProviderIdRejection("  Openai-Codex  ")).toContain("chatgpt-subscription");
	});

	it("does not reject the canonical ids", () => {
		expect(legacyProviderIdRejection("chatgpt-subscription")).toBeUndefined();
		expect(legacyProviderIdRejection("anthropic-subscription")).toBeUndefined();
	});

	it("does not reject the untouched API-key providers or an unrelated id", () => {
		expect(legacyProviderIdRejection("anthropic")).toBeUndefined();
		expect(legacyProviderIdRejection("openai")).toBeUndefined();
		expect(legacyProviderIdRejection("google")).toBeUndefined();
		expect(legacyProviderIdRejection("")).toBeUndefined();
	});
});
