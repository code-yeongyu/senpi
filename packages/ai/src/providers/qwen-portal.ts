import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_PORTAL_MODELS } from "./qwen-portal.models.ts";

export function qwenPortalProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-portal",
		name: "Qwen Portal",
		baseUrl: "https://portal.qwen.ai/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Portal token or API key", ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"]) },
		models: Object.values(QWEN_PORTAL_MODELS),
		api: openAICompletionsApi(),
	});
}
