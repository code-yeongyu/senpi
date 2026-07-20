import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { LM_STUDIO_MODELS } from "./lm-studio.models.ts";

export function lmStudioProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "lm-studio",
		name: "LM Studio",
		baseUrl: "http://127.0.0.1:1234/v1",
		auth: {
			apiKey: envApiKeyAuth("LM Studio API key", ["LM_STUDIO_API_KEY"], {
				fallbackApiKey: "lm-studio-local",
			}),
		},
		models: Object.values(LM_STUDIO_MODELS),
		api: openAICompletionsApi(),
	});
}
