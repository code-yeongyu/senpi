import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ONE_HUNDRED_MILIONSEEK_MODELS } from "./100milionseek.models.ts";

export function oneHundredMilionseekProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "100milionseek",
		name: "100milionseek",
		baseUrl: "https://100milionseek.top/v1",
		auth: { apiKey: envApiKeyAuth("100milionseek API key", ["100MILIONSEEK_API_KEY"]) },
		models: Object.values(ONE_HUNDRED_MILIONSEEK_MODELS),
		api: openAICompletionsApi(),
	});
}
