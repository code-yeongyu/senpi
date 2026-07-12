import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TAVILY_MODELS } from "./tavily.models.ts";

export function tavilyProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "tavily",
		name: "Tavily",
		baseUrl: "https://api.tavily.com",
		auth: { apiKey: envApiKeyAuth("Tavily API key", ["TAVILY_API_KEY"]) },
		models: Object.values(TAVILY_MODELS),
		api: openAICompletionsApi(),
	});
}
