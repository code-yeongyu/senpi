import { type Api, type Model, resolvePromptCacheTtlSeconds } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import { registerAnthropicSubscriptionExtension } from "../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

type ProviderRegistration = {
	api?: string;
	baseUrl?: string;
};

function captureRegisterProviderCall(): { args: [string, ProviderRegistration] } {
	const calls: Array<{ args: [string, ProviderRegistration] }> = [];
	const pi = {
		registerProvider: (name: string, config: ProviderRegistration) => {
			calls.push({ args: [name, config] });
		},
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		on: () => {},
	} as unknown as ExtensionAPI;
	registerAnthropicSubscriptionExtension(pi, {
		readAmbientAuthStatus: async () => false,
		readSettings: () => ({}),
	});
	const call = calls[0];
	if (!call) throw new Error("extension did not register a provider");
	return call;
}

describe("anthropic-subscription wire api id", () => {
	it("keeps the claude-sdk-oauth wire identity independent of the provider id", () => {
		const call = captureRegisterProviderCall();
		// A failure here means a rename went too far: restore the wire id, do not update the expected value.
		expect(call.args[1].api).toBe("claude-sdk-oauth");
		expect(call.args[1].baseUrl).toBe("claude-sdk-oauth");
		expect(call.args[1].api).toBe(CLAUDE_SDK_OAUTH_API_ID);
		expect(resolvePromptCacheTtlSeconds({ api: "claude-sdk-oauth" } as Model<Api>)).toBe(300);
	});
});
