import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { KAGI_MODELS } from "./kagi.models.ts";

export function kagiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "kagi",
		name: "Kagi",
		baseUrl: "https://kagi.com/api/v0",
		auth: { apiKey: envApiKeyAuth("Kagi API key", ["KAGI_API_KEY"]) },
		models: Object.values(KAGI_MODELS),
		api: openAICompletionsApi(),
	});
}
