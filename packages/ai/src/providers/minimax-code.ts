import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_CODE_MODELS } from "./minimax-code.models.ts";

export function minimaxCodeProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "minimax-code",
		name: "MiniMax Coding Plan",
		baseUrl: "https://api.minimax.io/v1",
		auth: { apiKey: envApiKeyAuth("MiniMax Coding Plan API key", ["MINIMAX_CODE_API_KEY"]) },
		models: Object.values(MINIMAX_CODE_MODELS),
		api: openAICompletionsApi(),
	});
}
