import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { cursorOAuth } from "./auth/oauth/cursor.ts";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import { gitlabDuoOAuth } from "./auth/oauth/gitlab-duo.ts";
import { googleAntigravityOAuth } from "./auth/oauth/google-antigravity.ts";
import { googleGeminiCliOAuth } from "./auth/oauth/google-gemini-cli.ts";
import { kiloOAuth } from "./auth/oauth/kilo.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import { openaiCodexDeviceOAuth } from "./auth/oauth/openai-codex-device.ts";
import { perplexityOAuth } from "./auth/oauth/perplexity.ts";
import { createRadiusOAuth } from "./auth/oauth/radius.ts";
import { xaiOAuth } from "./auth/oauth/xai.ts";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		openaiCodexDevice: () => openaiCodexDeviceOAuth,
		githubCopilot: () => githubCopilotOAuth,
		cursor: () => cursorOAuth,
		gitlabDuo: () => gitlabDuoOAuth,
		perplexity: () => perplexityOAuth,
		kilo: () => kiloOAuth,
		xai: () => xaiOAuth,
		googleGeminiCli: () => googleGeminiCliOAuth,
		googleAntigravity: () => googleAntigravityOAuth,
		radius: createRadiusOAuth,
	});
}
