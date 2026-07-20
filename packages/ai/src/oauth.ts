/** Compatibility entry point for coding-agent OAuth usage. */

// Runtime registry + loaders used by coding-agent AuthStorage / ModelRegistry / login.
export {
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
	registerOAuthProvider,
	resetOAuthProviders,
	resolveOAuthStorageProvider,
} from "./auth/oauth/index.ts";
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
} from "./auth/oauth/load.ts";
export type {
	OAuthProviderId,
	OAuthProviderInterface,
	OAuthRequestAuth,
} from "./auth/oauth/types.ts";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
