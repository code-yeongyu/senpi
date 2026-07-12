import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadOpenAICodexDeviceOAuth } from "../utils/oauth/load.ts";
import { OPENAI_CODEX_DEVICE_MODELS } from "./openai-codex-device.models.ts";

export function openaiCodexDeviceProvider(): Provider<"openai-codex-responses"> {
	return createProvider({
		id: "openai-codex-device",
		name: "OpenAI Codex (Device Code)",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT Plus/Pro, device code)",
				load: loadOpenAICodexDeviceOAuth,
			}),
		},
		models: Object.values(OPENAI_CODEX_DEVICE_MODELS),
		api: openAICodexResponsesApi(),
	});
}
