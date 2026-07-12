import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { VENICE_MODELS } from "./venice.models.ts";

export function veniceProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "venice",
		name: "Venice",
		baseUrl: "https://api.venice.ai/api/v1",
		auth: { apiKey: envApiKeyAuth("Venice API key", ["VENICE_API_KEY"]) },
		models: Object.values(VENICE_MODELS),
		api: openAICompletionsApi(),
	});
}
