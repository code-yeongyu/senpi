import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadPerplexityOAuth } from "../utils/oauth/load.ts";
import { PERPLEXITY_MODELS } from "./perplexity.models.ts";

export function perplexityProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "perplexity",
		name: "Perplexity",
		baseUrl: "https://api.perplexity.ai",
		auth: {
			apiKey: envApiKeyAuth("Perplexity API key", ["PERPLEXITY_API_KEY"]),
			oauth: lazyOAuth({ name: "Perplexity (Pro/Max)", load: loadPerplexityOAuth }),
		},
		models: Object.values(PERPLEXITY_MODELS),
		api: openAICompletionsApi(),
	});
}
