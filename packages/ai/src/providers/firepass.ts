import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { FIREPASS_MODELS } from "./firepass.models.ts";

export function firepassProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "firepass",
		name: "Fire Pass",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		auth: { apiKey: envApiKeyAuth("Fire Pass API key", ["FIREPASS_API_KEY"]) },
		models: Object.values(FIREPASS_MODELS),
		api: openAICompletionsApi(),
	});
}
