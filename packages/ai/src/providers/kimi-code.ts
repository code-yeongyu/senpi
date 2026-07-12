import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadKimiCodeOAuth } from "../utils/oauth/load.ts";
import { KIMI_CODE_MODELS } from "./kimi-code.models.ts";

export function kimiCodeProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "kimi-code",
		name: "Kimi Code",
		baseUrl: "https://api.kimi.com/coding/v1",
		auth: {
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			oauth: lazyOAuth({ name: "Kimi Code", load: loadKimiCodeOAuth }),
		},
		models: Object.values(KIMI_CODE_MODELS),
		api: openAICompletionsApi(),
	});
}
