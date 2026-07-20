import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { FUGU_MODELS } from "./fugu.models.ts";

export function fuguProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "fugu",
		name: "Sakana Fugu",
		baseUrl: "https://api.sakana.ai/v1",
		auth: { apiKey: envApiKeyAuth("Sakana Fugu API key", ["FUGU_API_KEY"]) },
		models: Object.values(FUGU_MODELS),
		api: openAICompletionsApi(),
	});
}
