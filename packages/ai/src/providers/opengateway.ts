import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENGATEWAY_MODELS } from "./opengateway.models.ts";

export function opengatewayProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "opengateway",
		name: "OpenGateway",
		baseUrl: "https://apis.opengateway.ai/v1",
		auth: { apiKey: envApiKeyAuth("OpenGateway API key", ["OPENGATEWAY_API_KEY"]) },
		models: Object.values(OPENGATEWAY_MODELS),
		api: openAICompletionsApi(),
	});
}
