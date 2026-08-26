import { describe, expect, it } from "vitest";
import { registerClaudeSdkOauthExtension } from "../../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import type { ClaudeSdkOauthProviderSettings } from "../../src/core/extensions/builtin/claude-sdk-oauth/settings.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

function registeredEligibility(readSettings: () => ClaudeSdkOauthProviderSettings): boolean | undefined {
	let captured: ProviderConfigInput | undefined;
	const pi = {
		registerProvider: (_name: string, config: ProviderConfigInput) => {
			captured = config;
		},
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		on: () => {},
	} as unknown as ExtensionAPI;
	registerClaudeSdkOauthExtension(pi, { readAmbientAuthStatus: async () => false, readSettings });
	if (!captured) throw new Error("extension did not register a provider");
	return captured.fallbackEligible?.();
}

describe("claude-sdk-oauth fallback eligibility", () => {
	it("declares the lane ineligible under the verbatim enabled:false kill switch", () => {
		expect(registeredEligibility(() => ({ enabled: false }))).toBe(false);
	});

	it("keeps the lane eligible when the flag is merely absent", () => {
		expect(registeredEligibility(() => ({}))).toBe(true);
	});

	it("keeps the lane eligible when the flag is set", () => {
		expect(registeredEligibility(() => ({ enabled: true }))).toBe(true);
	});

	it("stays eligible when settings cannot be read - expansion never shrinks on uncertainty", () => {
		expect(
			registeredEligibility(() => {
				throw new Error("unreadable settings");
			}),
		).toBe(true);
	});
});
