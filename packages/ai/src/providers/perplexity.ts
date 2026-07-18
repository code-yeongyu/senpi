import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { PERPLEXITY_MODELS } from "./perplexity.models.ts";

export function perplexityProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "perplexity",
		name: "Perplexity",
		baseUrl: "https://api.perplexity.ai",
		// API-key only. The OAuth flow (auth/oauth/perplexity.ts) returns a
		// www.perplexity.ai web-session JWT, which is NOT accepted by
		// api.perplexity.ai as a Bearer token — session tokens are not direct
		// API keys. The flow code is preserved for a future transport that
		// routes session requests through the web API instead.
		auth: {
			apiKey: envApiKeyAuth("Perplexity API key", ["PERPLEXITY_API_KEY"]),
		},
		models: Object.values(PERPLEXITY_MODELS),
		api: openAICompletionsApi(),
	});
}
