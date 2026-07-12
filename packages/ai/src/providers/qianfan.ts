import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QIANFAN_MODELS } from "./qianfan.models.ts";

export function qianfanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qianfan",
		name: "Qianfan",
		baseUrl: "https://qianfan.baidubce.com/v2",
		auth: { apiKey: envApiKeyAuth("Qianfan API key", ["QIANFAN_API_KEY"]) },
		models: Object.values(QIANFAN_MODELS),
		api: openAICompletionsApi(),
	});
}
