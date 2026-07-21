import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_CODE_CN_MODELS } from "./minimax-code-cn.models.ts";

export function minimaxCodeCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "minimax-code-cn",
		name: "MiniMax Coding Plan (China)",
		baseUrl: "https://api.minimaxi.com/v1",
		auth: { apiKey: envApiKeyAuth("MiniMax Coding Plan (China) API key", ["MINIMAX_CODE_CN_API_KEY"]) },
		models: Object.values(MINIMAX_CODE_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
