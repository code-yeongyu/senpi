import { openaiImagesApi } from "../api/openai-images.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_IMAGE_MODELS, OPENAI_MODELS } from "./openai.models.ts";

export function openaiProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: [...Object.values(OPENAI_MODELS), ...Object.values(OPENAI_IMAGE_MODELS)],
		api: openAIResponsesApi(),
		images: { "openai-images": openaiImagesApi() },
	});
}
