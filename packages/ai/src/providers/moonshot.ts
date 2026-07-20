import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MOONSHOT_MODELS } from "./moonshot.models.ts";

export function moonshotProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "moonshot",
		name: "Moonshot (Kimi API)",
		baseUrl: "https://api.moonshot.ai/v1",
		auth: { apiKey: envApiKeyAuth("Moonshot API key", ["MOONSHOT_API_KEY"]) },
		models: Object.values(MOONSHOT_MODELS),
		api: openAICompletionsApi(),
	});
}
