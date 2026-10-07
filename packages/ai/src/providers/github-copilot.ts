import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { githubCopilotBaseUrlFromToken } from "../api/github-copilot-endpoint.ts";
import { GITHUB_COPILOT_REJECTED_TOKEN_STATUSES } from "../api/github-copilot-headers.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";
import { applyGitHubCopilotModelLimits } from "./github-copilot-limits.ts";

// A Copilot session token passed as a key (an explicit per-request key, or COPILOT_GITHUB_TOKEN)
// still names its account's API host in `proxy-ep`; without it the request would fall back to the
// individual host and a Business or Enterprise account would get 421 Misdirected Request.
function withTokenBaseUrl(apiKey: ApiKeyAuth): ApiKeyAuth {
	return {
		...apiKey,
		resolve: async (input) => {
			const result = await apiKey.resolve(input);
			const baseUrl = result?.auth.apiKey ? githubCopilotBaseUrlFromToken(result.auth.apiKey) : undefined;
			return result && baseUrl && !result.auth.baseUrl ? { ...result, auth: { ...result.auth, baseUrl } } : result;
		},
	};
}

export function githubCopilotProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			apiKey: withTokenBaseUrl(envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"])),
			oauth: lazyOAuth({
				name: "GitHub Copilot",
				isSubscription: true,
				rejectedTokenStatuses: GITHUB_COPILOT_REJECTED_TOKEN_STATUSES,
				load: loadGitHubCopilotOAuth,
			}),
		},
		models: Object.values(GITHUB_COPILOT_MODELS),
		filterModels: (models, credential) => {
			if (credential?.type !== "oauth") return models;
			const availableModelIds = credential.availableModelIds;
			if (!Array.isArray(availableModelIds) || !availableModelIds.every((id) => typeof id === "string")) {
				return models;
			}
			const available = new Set(availableModelIds);
			return applyGitHubCopilotModelLimits(
				models.filter((model) => available.has(model.id)),
				credential,
			);
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
