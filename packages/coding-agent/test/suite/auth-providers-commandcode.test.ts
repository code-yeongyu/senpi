import { getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { isApiKeyLoginProvider } from "../../src/core/auth-providers.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../src/core/provider-display-names.ts";

describe("CommandCode /login eligibility", () => {
	const builtInProviderIds = new Set<string>(getProviders());

	it("offers CommandCode for API-key login like other built-in key providers", () => {
		expect(isApiKeyLoginProvider("commandcode", new Set(), builtInProviderIds)).toBe(true);
	});

	it("continues to exclude built-in providers without a display name from API-key login", () => {
		expect(isApiKeyLoginProvider("qwen-token-plan", new Set(), builtInProviderIds)).toBe(false);
	});

	it("registers the CommandCode display name used by the login selector", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.commandcode).toBe("CommandCode");
	});
});
