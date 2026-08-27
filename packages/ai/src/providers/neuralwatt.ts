import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { NEURALWATT_MODELS } from "./neuralwatt.models.ts";

export function neuralwattProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "neuralwatt",
		name: "Neuralwatt",
		baseUrl: "https://api.neuralwatt.com/v1",
		auth: { apiKey: envApiKeyAuth("Neuralwatt API key", ["NEURALWATT_API_KEY"]) },
		models: Object.values(NEURALWATT_MODELS),
		api: openAICompletionsApi(),
	});
}
