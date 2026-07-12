import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadGitLabDuoOAuth } from "../utils/oauth/load.ts";
import { GITLAB_DUO_MODELS } from "./gitlab-duo.models.ts";

export function gitlabDuoProvider(): Provider<"anthropic-messages" | "openai-responses"> {
	return createProvider({
		id: "gitlab-duo",
		name: "GitLab Duo",
		baseUrl: "https://cloud.gitlab.com",
		auth: {
			apiKey: envApiKeyAuth("GitLab token", ["GITLAB_TOKEN"]),
			oauth: lazyOAuth({ name: "GitLab Duo", load: loadGitLabDuoOAuth }),
		},
		models: Object.values(GITLAB_DUO_MODELS),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
