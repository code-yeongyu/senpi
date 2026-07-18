import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { getGitLabDuoDirectAccess } from "../auth/oauth/gitlab-duo-direct-access.ts";
import { loadGitLabDuoOAuth } from "../auth/oauth/load.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { GITLAB_DUO_MODELS } from "./gitlab-duo.models.ts";

const GITLAB_TOKEN_ENV = ["GITLAB_TOKEN"] as const;

/**
 * GitLab PAT / stored API keys must be exchanged for a short-lived
 * direct-access token + instance headers before proxy requests.
 * Raw PATs are rejected by the AI proxy.
 */
function gitlabDuoApiKeyAuth(): ApiKeyAuth {
	return {
		name: "GitLab token",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter GitLab token" });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			let token: string | undefined;
			let source = "stored credential";
			if (credential?.key) {
				token = credential.key;
			} else {
				for (const envVar of GITLAB_TOKEN_ENV) {
					const value = await ctx.env(envVar);
					if (value) {
						token = value;
						source = envVar;
						break;
					}
				}
			}
			if (!token) return undefined;
			const directAccess = await getGitLabDuoDirectAccess(token);
			return {
				auth: {
					apiKey: directAccess.token,
					headers: { ...directAccess.headers, Authorization: `Bearer ${directAccess.token}` },
				},
				source,
			};
		},
	};
}

export function gitlabDuoProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return createProvider({
		id: "gitlab-duo",
		name: "GitLab Duo",
		baseUrl: "https://cloud.gitlab.com",
		auth: {
			apiKey: gitlabDuoApiKeyAuth(),
			oauth: lazyOAuth({ name: "GitLab Duo", load: loadGitLabDuoOAuth }),
		},
		models: Object.values(GITLAB_DUO_MODELS),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
