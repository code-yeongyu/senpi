import type { generateImages as generateImagesOpenAIFunction } from "../../api/openai-images.ts";
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerBuiltinImagesApiProvider } from "../../images-api-registry.ts";
import type {
	AssistantImages,
	ImagesApi,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
} from "../../types.ts";

interface ImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

let openRouterImagesProviderModulePromise: Promise<ImagesProviderModule> | undefined;
let openAIImagesProviderModulePromise: Promise<typeof generateImagesOpenAIFunction> | undefined;

function createLazyLoadErrorImages<TApi extends ImagesApi>(model: ImagesModel<TApi>, error: unknown): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function loadOpenRouterImagesProviderModule(): Promise<ImagesProviderModule> {
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		(module) => module as ImagesProviderModule,
	);
	return openRouterImagesProviderModulePromise;
}

export const generateImagesOpenRouter: ImagesFunction<"openrouter-images", ImagesOptions> = async (
	model: ImagesModel<"openrouter-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export const generateImagesOpenAI: ImagesFunction<"openai-images", ImagesOptions> = async (
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenAIImagesProviderModule();
		return await module(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

function loadOpenAIImagesProviderModule(): Promise<typeof generateImagesOpenAIFunction> {
	openAIImagesProviderModulePromise ||= import("../../api/openai-images.ts").then((module) => module.generateImages);
	return openAIImagesProviderModulePromise;
}

export function registerBuiltInImagesApiProviders(): void {
	registerBuiltinImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
	registerBuiltinImagesApiProvider({
		api: "openai-images",
		generateImages: generateImagesOpenAI,
	});
}

registerBuiltInImagesApiProviders();
