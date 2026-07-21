import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { VLLM_MODELS } from "./vllm.models.ts";

export function vllmProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "vllm",
		name: "vLLM",
		baseUrl: "http://127.0.0.1:8000/v1",
		auth: {
			apiKey: envApiKeyAuth("vLLM API key", ["VLLM_API_KEY"], { fallbackApiKey: "vllm-local" }),
		},
		models: Object.values(VLLM_MODELS),
		api: openAICompletionsApi(),
	});
}
