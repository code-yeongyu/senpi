import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { NANOGPT_MODELS } from "./nanogpt.models.ts";

export function nanogptProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "nanogpt",
		name: "NanoGPT",
		baseUrl: "https://nano-gpt.com/api/v1",
		auth: { apiKey: envApiKeyAuth("NanoGPT API key", ["NANO_GPT_API_KEY"]) },
		models: Object.values(NANOGPT_MODELS),
		api: openAICompletionsApi(),
	});
}
