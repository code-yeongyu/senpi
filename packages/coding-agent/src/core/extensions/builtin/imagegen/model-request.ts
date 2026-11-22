import { isModelConfigError } from "@earendil-works/pi-ai";
import type { AssistantImages, ImageModel, ProviderImagesOptions } from "@earendil-works/pi-ai/compat";
import { generateImages, getImageModel } from "@earendil-works/pi-ai/compat";
import type { ImageGenCandidate } from "./auth.ts";
import { IMAGE_MODEL_FALLBACKS, IMAGE_MODEL_NAMES, type ImageModelId, supportsComplexity } from "./params.ts";

export type ImageComplexity = "low" | "medium" | "high";

export interface ModelAttempt {
	images: AssistantImages;
	model: ImageModelId;
	fallbackFrom?: ImageModelId;
}

function synthesizeModel(auth: ImageGenCandidate, id: ImageModelId): ImageModel<"openai-images"> {
	return {
		type: "image",
		id,
		name: IMAGE_MODEL_NAMES[id],
		api: "openai-images",
		provider: auth.providerId ?? "openai",
		baseUrl: auth.baseUrl,
		input: ["text", "image"],
		output: ["image"],
		cost: getImageModel("openai", id).cost,
	};
}

/**
 * Sends one generation request to `auth`, and when the endpoint answers that it does not serve the requested
 * 2.6 model (gateway allowlists lag OpenAI releases, senpi#5820) retries exactly once on the 2.5 counterpart
 * without `complexity`, which 2.5 does not accept. Every other result, success or failure, is returned as is.
 */
export async function requestImagesWithModelFallback(
	auth: ImageGenCandidate,
	model: ImageModelId,
	context: Parameters<typeof generateImages>[1],
	options: ProviderImagesOptions,
	complexity: ImageComplexity | undefined,
): Promise<ModelAttempt> {
	const send = (id: ImageModelId) =>
		generateImages(synthesizeModel(auth, id), context, {
			...options,
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(auth.headers === undefined ? {} : { headers: auth.headers }),
			...(complexity !== undefined && supportsComplexity(id) ? { complexity } : {}),
		});
	const images = await send(model);
	const fallback = IMAGE_MODEL_FALLBACKS[model];
	if (fallback === undefined || images.stopReason !== "error" || !isModelConfigError(images.errorMessage)) {
		return { images, model };
	}
	return { images: await send(fallback), model: fallback, fallbackFrom: model };
}
