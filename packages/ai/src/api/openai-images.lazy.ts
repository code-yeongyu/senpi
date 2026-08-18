import type { ImagesModel, ProviderImages } from "../types.ts";

export const openaiImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) => {
		if (model.api !== "openai-images") {
			throw new Error(`Mismatched api: ${model.api} expected openai-images`);
		}
		const openaiModel = { ...model, api: "openai-images" } satisfies ImagesModel<"openai-images">;
		return (await import("./openai-images.ts")).generateImages(openaiModel, context, options);
	},
});
