/**
 * OAuth credential management for AI providers.
 *
 * This module handles login, token refresh, and credential storage
 * for OAuth-based providers:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 */

// Anthropic
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.ts";
export * from "./cursor.ts";
export * from "./device-code.ts";
// GitHub Copilot
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.ts";
export * from "./gitlab-duo.ts";
export * from "./glm-zcode.ts";
export { googleAntigravityOAuthProvider, loginAntigravity, refreshAntigravityToken } from "./google-antigravity.ts";
export { googleGeminiCliOAuthProvider, loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli.ts";
export * from "./kilo.ts";
export * from "./kimi-code.ts";
// OpenAI Codex (ChatGPT OAuth)
export {
	loginOpenAICodex,
	loginOpenAICodexDeviceCode,
	OPENAI_CODEX_BROWSER_LOGIN_METHOD,
	OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "./openai-codex.ts";
export * from "./openai-codex-device.ts";
export * from "./perplexity.ts";
export * from "./types.ts";
export {
	discoverXaiOAuthEndpoints,
	exchangeXaiAuthorizationCode,
	loginXai,
	refreshXaiToken,
	xaiOAuthProvider,
} from "./xai.ts";

// ============================================================================
// Provider Registry
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.ts";
import { cursorOAuthProvider } from "./cursor.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { gitlabDuoOAuthProvider } from "./gitlab-duo.ts";
import { glmZcodeOAuthProvider } from "./glm-zcode.ts";
import { googleAntigravityOAuthProvider } from "./google-antigravity.ts";
import { googleGeminiCliOAuthProvider } from "./google-gemini-cli.ts";
import { kiloOAuthProvider } from "./kilo.ts";
import { kimiCodeOAuthProvider } from "./kimi-code.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import { openaiCodexDeviceOAuthProvider } from "./openai-codex-device.ts";
import { perplexityOAuthProvider } from "./perplexity.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";
import { xaiOAuthProvider } from "./xai.ts";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	githubCopilotOAuthProvider,
	openaiCodexOAuthProvider,
	openaiCodexDeviceOAuthProvider,
	kimiCodeOAuthProvider,
	cursorOAuthProvider,
	gitlabDuoOAuthProvider,
	perplexityOAuthProvider,
	kiloOAuthProvider,
	glmZcodeOAuthProvider,
	xaiOAuthProvider,
	googleGeminiCliOAuthProvider,
	googleAntigravityOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Resolve login-only provider aliases to the credential owner used by models.
 */
export function resolveOAuthStorageProvider(id: OAuthProviderId): OAuthProviderId {
	return id === "openai-codex-device" ? "openai-codex" : id;
}

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/**
 * Unregister an OAuth provider.
 *
 * If the provider is built-in, restores the built-in implementation.
 * Custom providers are removed completely.
 */
export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

/**
 * Reset OAuth providers to built-ins.
 */
export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// High-level API (uses provider registry)
// ============================================================================

/**
 * Refresh token for any OAuth provider.
 * @deprecated Use getOAuthProvider(id).refreshToken() instead
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await provider.refreshToken(creds);
		} catch (_error) {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
