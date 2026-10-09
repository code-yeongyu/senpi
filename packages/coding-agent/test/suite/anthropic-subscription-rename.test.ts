import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../../src/core/extensions/builtin/anthropic-subscription/account-management.ts";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import { registerAnthropicSubscriptionExtension } from "../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import { ANTHROPIC_SUBSCRIPTION_NAME } from "../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { isResidentAssistant } from "../../src/core/extensions/builtin/anthropic-subscription/session-commit-boundary.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../src/core/provider-display-names.ts";
import { rankFamilyModels } from "../../src/core/retry-fallback/expansion.ts";

/**
 * Provider rename: `claude-sdk-oauth` -> `anthropic-subscription` (display name
 * "Claude SDK OAuth" -> "Anthropic Subscription"). The wire api id stays frozen
 * at `claude-sdk-oauth` (api-id.ts), and the builtin EXTENSION id stays
 * `claude-sdk-oauth` because user settings persist it in
 * `enabledBuiltinExtensions` / `disabledBuiltinExtensions`.
 */

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

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "faux",
		baseUrl: "https://models.example.test/v1",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text"],
		contextWindow: 1,
		maxTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function assistant(api: string, provider: string): AssistantMessage {
	return {
		role: "assistant",
		api,
		provider,
		model: "claude-opus-5",
		content: [{ type: "text", text: "answer" }],
	} as AssistantMessage;
}

describe("anthropic-subscription provider rename", () => {
	it("registers the provider under anthropic-subscription with the frozen claude-sdk-oauth wire api", () => {
		const call = captureRegisterProviderCall();
		expect(call.args[0]).toBe("anthropic-subscription");
		expect(call.args[1].api).toBe(CLAUDE_SDK_OAUTH_API_ID);
		expect(call.args[1].baseUrl).toBe("claude-sdk-oauth");
	});

	it("exposes the new provider id through the frozen symbol", () => {
		expect(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID).toBe("anthropic-subscription");
	});

	it("carries the Anthropic Subscription login label", () => {
		expect(ANTHROPIC_SUBSCRIPTION_NAME).toBe("Anthropic Subscription (Claude Pro/Max)");
	});

	it("maps the anthropic-subscription display name", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES["anthropic-subscription"]).toBe("Anthropic Subscription");
	});

	it("holds the rung claude-sdk-oauth held in the fallback precedence table", () => {
		const ranked = rankFamilyModels(
			[model("anthropic-subscription", "claude-opus-5"), model("anthropic", "claude-opus-5")],
			"claude-opus-5",
			{ isUsingOAuth: () => false },
		);
		// omo #8051/#8059: the subscription lane must stay AHEAD of the metered
		// anthropic API-key lane; absent table entries sort alphabetically last.
		expect(ranked[0]?.provider).toBe("anthropic-subscription");
	});

	it("keeps resident-assistant identity split across the frozen api id and the renamed provider id", () => {
		expect(isResidentAssistant(assistant("claude-sdk-oauth", "anthropic-subscription"), "claude-opus-5")).toBe(true);
		expect(isResidentAssistant(assistant("claude-sdk-oauth", "anthropic"), "claude-opus-5")).toBe(false);
	});
});
