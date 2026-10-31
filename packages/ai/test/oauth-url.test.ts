import { describe, expect, it } from "vitest";
import { redactOAuthUrl } from "../src/utils/oauth-url.ts";

describe("OAuth authorization URL redaction (#5003)", () => {
	it.each([
		"id_token_hint=retained-token&client_id=oaiapp_saved",
		"client_id=oaiapp_saved&id_token_hint=retained-token",
		"client_id=oaiapp_saved&id%5Ftoken%5Fhint=retained-token&id_token_hint=another-token",
	])("removes all ID-token hints from printable URLs: %s", (query) => {
		const url = new URL(redactOAuthUrl(`https://auth.openai.com/api/accounts/authorize?${query}`));
		expect(url.searchParams.has("id_token_hint")).toBe(false);
		expect(url.searchParams.get("client_id")).toBe("oaiapp_saved");
		expect(url.toString()).not.toContain("retained-token");
		expect(url.toString()).not.toContain("another-token");
	});

	it("preserves registration URLs byte for byte", () => {
		const url = "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&scope=openid%20email";
		expect(redactOAuthUrl(url)).toBe(url);
	});
});
