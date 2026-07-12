import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadGlmZcodeOAuth } from "../utils/oauth/load.ts";
import { GLM_ZCODE_MODELS } from "./glm-zcode.models.ts";

export function glmZcodeProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "glm-zcode",
		name: "GLM ZCode (unofficial, opt-in)",
		baseUrl: "https://api.z.ai/api/anthropic",
		auth: {
			apiKey: envApiKeyAuth("GLM ZCode API key", ["GLM_ZCODE_API_KEY"]),
			oauth: lazyOAuth({ name: "GLM ZCode OAuth (unofficial, opt-in)", load: loadGlmZcodeOAuth }),
		},
		models: Object.values(GLM_ZCODE_MODELS),
		api: anthropicMessagesApi(),
	});
}
