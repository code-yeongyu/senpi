import { describe, expect, it } from "vitest";
import { isApiKeyLoginProvider } from "../src/core/auth-providers.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.ts";

describe("OpenGateway provider login", () => {
	it("exposes a built-in display name", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.opengateway).toBe("OpenGateway");
	});

	it("is eligible for API-key /login", () => {
		expect(isApiKeyLoginProvider("opengateway", new Set())).toBe(true);
	});
});
