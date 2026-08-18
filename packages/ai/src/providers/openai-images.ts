import { openaiImagesApi } from "../api/openai-images.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { IMAGE_MODELS } from "../image-models.generated.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";

export function openaiImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openai",
		name: "OpenAI",
		auth: {
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
		},
		models: Object.values(IMAGE_MODELS.openai),
		api: openaiImagesApi(),
	});
}
