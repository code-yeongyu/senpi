import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZENMUX_MODELS } from "./zenmux.models.ts";

export function zenmuxProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "zenmux",
		name: "ZenMux",
		baseUrl: "https://zenmux.ai/api/anthropic",
		auth: { apiKey: envApiKeyAuth("ZenMux API key", ["ZENMUX_API_KEY"]) },
		models: Object.values(ZENMUX_MODELS),
		api: anthropicMessagesApi(),
	});
}
