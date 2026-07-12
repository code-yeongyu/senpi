import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { SYNTHETIC_MODELS } from "./synthetic.models.ts";

export function syntheticProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "synthetic",
		name: "Synthetic",
		baseUrl: "https://api.synthetic.new/openai/v1",
		auth: { apiKey: envApiKeyAuth("Synthetic API key", ["SYNTHETIC_API_KEY"]) },
		models: Object.values(SYNTHETIC_MODELS),
		api: openAICompletionsApi(),
	});
}
