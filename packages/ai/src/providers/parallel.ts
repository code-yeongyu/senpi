import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { PARALLEL_MODELS } from "./parallel.models.ts";

export function parallelProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "parallel",
		name: "Parallel",
		baseUrl: "https://api.parallel.ai/v1beta",
		auth: { apiKey: envApiKeyAuth("Parallel API key", ["PARALLEL_API_KEY"]) },
		models: Object.values(PARALLEL_MODELS),
		api: openAICompletionsApi(),
	});
}
