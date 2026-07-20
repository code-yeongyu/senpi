import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { LITELLM_MODELS } from "./litellm.models.ts";

export function litellmProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "litellm",
		name: "LiteLLM",
		baseUrl: "http://localhost:4000/v1",
		auth: { apiKey: envApiKeyAuth("LiteLLM API key", ["LITELLM_API_KEY"]) },
		models: Object.values(LITELLM_MODELS),
		api: openAICompletionsApi(),
	});
}
