import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { VENICE_MODELS } from "./venice.models.ts";
import { veniceE2EEModels, withVeniceE2EE } from "./venice-e2ee.ts";

export function veniceProvider(): Provider<"openai-completions"> {
	const generated = Object.values(VENICE_MODELS);
	const generatedIds = new Set<string>(generated.map((model) => model.id));
	const e2ee = veniceE2EEModels().filter((model) => !generatedIds.has(model.id));
	return createProvider({
		id: "venice",
		name: "Venice AI",
		baseUrl: "https://api.venice.ai/api/v1",
		auth: { apiKey: envApiKeyAuth("Venice API key", ["VENICE_API_KEY"]) },
		models: [...generated, ...e2ee],
		api: withVeniceE2EE(openAICompletionsApi()),
	});
}
