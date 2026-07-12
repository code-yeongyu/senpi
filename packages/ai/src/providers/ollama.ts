import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OLLAMA_MODELS } from "./ollama.models.ts";

export function ollamaProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "ollama",
		name: "Ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		auth: {
			apiKey: envApiKeyAuth("Ollama API key", ["OLLAMA_API_KEY"], { fallbackApiKey: "ollama-local" }),
		},
		models: Object.values(OLLAMA_MODELS),
		api: openAICompletionsApi(),
	});
}
