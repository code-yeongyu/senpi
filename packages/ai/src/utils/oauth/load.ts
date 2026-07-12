import type { OAuthAuth } from "../../auth/types.ts";

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

export const loadAnthropicOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth }).anthropicOAuth;

export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth }).openaiCodexOAuth;

export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./github-copilot.ts")) as { githubCopilotOAuth: OAuthAuth }).githubCopilotOAuth;

export const loadCursorOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./cursor.ts")) as { cursorOAuth: OAuthAuth }).cursorOAuth;

export const loadGitLabDuoOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./gitlab-duo.ts")) as { gitlabDuoOAuth: OAuthAuth }).gitlabDuoOAuth;

export const loadPerplexityOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./perplexity.ts")) as { perplexityOAuth: OAuthAuth }).perplexityOAuth;

export const loadKiloOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./kilo.ts")) as { kiloOAuth: OAuthAuth }).kiloOAuth;

export const loadGlmZcodeOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./glm-zcode.ts")) as { glmZcodeOAuth: OAuthAuth }).glmZcodeOAuth;

export const loadXaiOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./xai.ts")) as { xaiOAuth: OAuthAuth }).xaiOAuth;

export const loadGoogleGeminiCliOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./google-gemini-cli.ts")) as { googleGeminiCliOAuth: OAuthAuth }).googleGeminiCliOAuth;

export const loadGoogleAntigravityOAuth = async (): Promise<OAuthAuth> =>
	((await importOAuthModule("./google-antigravity.ts")) as { googleAntigravityOAuth: OAuthAuth })
		.googleAntigravityOAuth;
