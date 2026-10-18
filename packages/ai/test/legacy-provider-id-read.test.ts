import { describe, expect, it } from "vitest";
import { legacyProviderIdsFor, readByProviderId } from "../src/legacy-provider-ids.ts";

describe("legacy provider id read helpers (senpi#1989)", () => {
	it("maps a canonical id back to its legacy spellings", () => {
		expect(legacyProviderIdsFor("anthropic-subscription")).toEqual(["claude-sdk-oauth"]);
		expect(legacyProviderIdsFor("chatgpt-subscription")).toEqual(["openai-codex"]);
	});

	it("returns no legacy spelling for an id that was never renamed", () => {
		expect(legacyProviderIdsFor("anthropic")).toEqual([]);
		expect(legacyProviderIdsFor("openai")).toEqual([]);
	});

	it("reads a record written under the legacy key by its canonical id", () => {
		const record = { "claude-sdk-oauth": { token: "legacy" } };
		expect(readByProviderId(record, "anthropic-subscription")).toEqual({ token: "legacy" });
		expect(readByProviderId(record, "claude-sdk-oauth")).toEqual({ token: "legacy" });
	});

	it("prefers the canonical key when both spellings are present", () => {
		const record = { "anthropic-subscription": { token: "canonical" }, "claude-sdk-oauth": { token: "legacy" } };
		expect(readByProviderId(record, "anthropic-subscription")).toEqual({ token: "canonical" });
	});

	it("never confuses the untouched API-key providers", () => {
		const record = { anthropic: { token: "api-key" }, "anthropic-subscription": { token: "subscription" } };
		expect(readByProviderId(record, "anthropic")).toEqual({ token: "api-key" });
		expect(readByProviderId(record, "anthropic-subscription")).toEqual({ token: "subscription" });
	});

	it("returns undefined for a missing id and an absent record", () => {
		expect(readByProviderId({ x: 1 }, "anthropic-subscription")).toBeUndefined();
		expect(readByProviderId(undefined, "anthropic-subscription")).toBeUndefined();
	});
});
