import type { OAuthAuth } from "../types.ts";

/**
 * Loads an OAuth flow module through a variable specifier so bundlers cannot
 * follow the import into Node-only flow code (`node:http` callback servers,
 * `node:crypto` PKCE). The `.ts`/`.js` rewrite keeps the trick working from
 * both source and built output.
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

type OAuthFlowLoaders = {
	anthropic: () => OAuthAuth | Promise<OAuthAuth>;
	openaiCodex: () => OAuthAuth | Promise<OAuthAuth>;
	openaiCodexDevice: () => OAuthAuth | Promise<OAuthAuth>;
	githubCopilot: () => OAuthAuth | Promise<OAuthAuth>;
	cursor: () => OAuthAuth | Promise<OAuthAuth>;
	gitlabDuo: () => OAuthAuth | Promise<OAuthAuth>;
	perplexity: () => OAuthAuth | Promise<OAuthAuth>;
	kilo: () => OAuthAuth | Promise<OAuthAuth>;
	xai: () => OAuthAuth | Promise<OAuthAuth>;
	googleGeminiCli: () => OAuthAuth | Promise<OAuthAuth>;
	googleAntigravity: () => OAuthAuth | Promise<OAuthAuth>;
	radius: (options: { name: string; gateway: string }) => OAuthAuth | Promise<OAuthAuth>;
};

let bundledLoaders: OAuthFlowLoaders | undefined;

/** Registers statically bundled OAuth flows for standalone Bun binaries. */
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
	bundledLoaders = loaders;
}

export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.anthropic();
	return ((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth }).anthropicOAuth;
};

export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openaiCodex();
	return ((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth }).openaiCodexOAuth;
};

export const loadOpenAICodexDeviceOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openaiCodexDevice();
	return ((await importOAuthModule("./openai-codex-device.ts")) as { openaiCodexDeviceOAuth: OAuthAuth })
		.openaiCodexDeviceOAuth;
};

export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.githubCopilot();
	return ((await importOAuthModule("./github-copilot.ts")) as { githubCopilotOAuth: OAuthAuth }).githubCopilotOAuth;
};

export const loadCursorOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.cursor();
	return ((await importOAuthModule("./cursor.ts")) as { cursorOAuth: OAuthAuth }).cursorOAuth;
};

export const loadGitLabDuoOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.gitlabDuo();
	return ((await importOAuthModule("./gitlab-duo.ts")) as { gitlabDuoOAuth: OAuthAuth }).gitlabDuoOAuth;
};

export const loadPerplexityOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.perplexity();
	return ((await importOAuthModule("./perplexity.ts")) as { perplexityOAuth: OAuthAuth }).perplexityOAuth;
};

export const loadKiloOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.kilo();
	return ((await importOAuthModule("./kilo.ts")) as { kiloOAuth: OAuthAuth }).kiloOAuth;
};

export const loadXaiOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.xai();
	return ((await importOAuthModule("./xai.ts")) as { xaiOAuth: OAuthAuth }).xaiOAuth;
};

export const loadGoogleGeminiCliOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.googleGeminiCli();
	return ((await importOAuthModule("./google-gemini-cli.ts")) as { googleGeminiCliOAuth: OAuthAuth })
		.googleGeminiCliOAuth;
};

export const loadGoogleAntigravityOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.googleAntigravity();
	return ((await importOAuthModule("./google-antigravity.ts")) as { googleAntigravityOAuth: OAuthAuth })
		.googleAntigravityOAuth;
};

export const loadRadiusOAuth = async (options: { name: string; gateway: string }): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.radius(options);
	return (
		(await importOAuthModule("./radius.ts")) as {
			createRadiusOAuth: (input: { name: string; gateway: string }) => OAuthAuth;
		}
	).createRadiusOAuth(options);
};
