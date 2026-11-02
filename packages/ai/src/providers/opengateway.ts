import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { OPENGATEWAY_MODELS } from "./opengateway.models.ts";
import { createOpenGatewayCatalog } from "./opengateway-refresh.ts";

export function opengatewayProvider(): Provider<"openai-completions"> {
	const shipped = Object.values(OPENGATEWAY_MODELS);
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	const catalog = createOpenGatewayCatalog(shipped, Number.isNaN(generatedAt) ? undefined : generatedAt);
	const provider = createProvider({
		id: "opengateway",
		name: "OpenGateway",
		baseUrl: "https://apis.opengateway.ai/v1",
		auth: { apiKey: envApiKeyAuth("OpenGateway API key", ["OPENGATEWAY_API_KEY"]) },
		models: shipped,
		api: openAICompletionsApi(),
	});
	return {
		...provider,
		getModels: catalog.getModels,
		getAllModels: catalog.getModels,
		refreshModels: catalog.refresh,
	};
}
