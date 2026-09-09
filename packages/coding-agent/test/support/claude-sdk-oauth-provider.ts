import type { AuthContext, Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
	CLAUDE_SDK_OAUTH_PROVIDER_ID,
	registerClaudeSdkOauthExtension,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import type { ClaudeSdkOauthProviderSettings } from "../../src/core/extensions/builtin/claude-sdk-oauth/settings.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ModelConfig } from "../../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../../src/core/provider-composer.ts";

function registeredProviderConfig(
	readAmbientAuthStatus: () => Promise<boolean>,
	settings: ClaudeSdkOauthProviderSettings,
): ProviderConfigInput {
	let captured: ProviderConfigInput | undefined;
	const pi = new Proxy(
		{},
		{
			get:
				(_target, property) =>
				(...args: unknown[]) => {
					if (property === "registerProvider") captured = args[1] as ProviderConfigInput;
				},
		},
	) as unknown as ExtensionAPI;
	registerClaudeSdkOauthExtension(pi, { readAmbientAuthStatus, readSettings: () => settings });
	if (!captured) throw new Error("extension did not register a provider");
	return captured;
}

/**
 * `settings` is the provider settings block the auth predicate sees; the ambient
 * lane needs `{ enabled: true }` to be available, so tests that exercise a
 * logged-in host CLI must opt in explicitly instead of inheriting the host.
 */
export function composedProvider(
	readAmbientAuthStatus: () => Promise<boolean>,
	overrides: Partial<ProviderConfigInput> = {},
	settings: ClaudeSdkOauthProviderSettings = {},
) {
	const modelConfig = { getProvider: () => undefined } as unknown as ModelConfig;
	return composeModelProvider(CLAUDE_SDK_OAUTH_PROVIDER_ID, undefined, modelConfig, {
		...registeredProviderConfig(readAmbientAuthStatus, settings),
		...overrides,
	});
}

export function credentialStore(stored?: Credential): CredentialStore {
	return {
		read: async (): Promise<Credential | undefined> => stored,
		list: async () => [],
		modify: async (_providerId, fn) => (stored = (await fn(stored)) ?? stored),
		delete: async () => {
			stored = undefined;
		},
	};
}

export function authContext(environment: Record<string, string> = {}): AuthContext {
	return {
		env: async (name) => environment[name],
		fileExists: async () => false,
	};
}
