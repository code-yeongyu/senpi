import type { AuthContext, Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
	CLAUDE_SDK_OAUTH_PROVIDER_ID,
	registerClaudeSdkOauthExtension,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ModelConfig } from "../../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../../src/core/provider-composer.ts";

function registeredProviderConfig(readAmbientAuthStatus: () => Promise<boolean>): ProviderConfigInput {
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
	registerClaudeSdkOauthExtension(pi, { readAmbientAuthStatus });
	if (!captured) throw new Error("extension did not register a provider");
	return captured;
}

export function composedProvider(
	readAmbientAuthStatus: () => Promise<boolean>,
	overrides: Partial<ProviderConfigInput> = {},
) {
	const modelConfig = { getProvider: () => undefined } as unknown as ModelConfig;
	return composeModelProvider(CLAUDE_SDK_OAUTH_PROVIDER_ID, undefined, modelConfig, {
		...registeredProviderConfig(readAmbientAuthStatus),
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
