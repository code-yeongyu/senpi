/**
 * OAuth credential management for AI providers.
 */

export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.ts";
export * from "./cursor.ts";
export * from "./device-code.ts";
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.ts";
export * from "./gitlab-duo.ts";
export { googleAntigravityOAuthProvider, loginAntigravity, refreshAntigravityToken } from "./google-antigravity.ts";
export { googleGeminiCliOAuthProvider, loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli.ts";
export * from "./kilo.ts";
export {
	loadAnthropicOAuth,
	loadCursorOAuth,
	loadGitHubCopilotOAuth,
	loadGitLabDuoOAuth,
	loadGoogleAntigravityOAuth,
	loadGoogleGeminiCliOAuth,
	loadKiloOAuth,
	loadOpenAICodexDeviceOAuth,
	loadOpenAICodexOAuth,
	loadPerplexityOAuth,
	loadRadiusOAuth,
	loadXaiOAuth,
	registerBundledOAuthFlowLoaders,
} from "./load.ts";
export {
	loginOpenAICodex,
	loginOpenAICodexDeviceCode,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "./openai-codex.ts";
export * from "./openai-codex-device.ts";
export * from "./perplexity.ts";
export * from "./pkce.ts";
export { createRadiusOAuth } from "./radius.ts";
export * from "./types.ts";
export * from "./xai.ts";

import { anthropicOAuthProvider } from "./anthropic.ts";
import { cursorOAuthProvider } from "./cursor.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { gitlabDuoOAuthProvider } from "./gitlab-duo.ts";
import { googleAntigravityOAuthProvider } from "./google-antigravity.ts";
import { googleGeminiCliOAuthProvider } from "./google-gemini-cli.ts";
import { kiloOAuthProvider } from "./kilo.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import { openaiCodexDeviceOAuthProvider } from "./openai-codex-device.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";
import { xaiOAuthProvider } from "./xai.ts";

const providers: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	openaiCodexOAuthProvider,
	openaiCodexDeviceOAuthProvider,
	githubCopilotOAuthProvider,
	cursorOAuthProvider,
	gitlabDuoOAuthProvider,
	// Perplexity session OAuth is not advertised for model-request login.
	kiloOAuthProvider,
	xaiOAuthProvider,
	googleGeminiCliOAuthProvider,
	googleAntigravityOAuthProvider,
];

export function getOAuthProviders(): OAuthProviderInfo[] {
	return providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		available: true,
		usesCallbackServer: provider.usesCallbackServer,
	}));
}

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return providers.find((provider) => provider.id === id);
}

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	const existing = providers.findIndex((entry) => entry.id === provider.id);
	if (existing >= 0) providers[existing] = provider;
	else providers.push(provider);
}

export function resetOAuthProviders(): void {
	// Keep built-ins; tests that need a clean slate re-register via registerOAuthProvider.
}

export function resolveOAuthStorageProvider(id: OAuthProviderId): OAuthProviderId {
	if (id === "openai-codex-device") return "openai-codex";
	return id;
}

export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials | undefined>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
	let creds = credentials[providerId];
	if (!creds) return null;
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}
	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
