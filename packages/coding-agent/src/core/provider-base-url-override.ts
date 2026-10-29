import { type AnyModel, isModelType } from "@earendil-works/pi-ai";
import type { ModelsJsonProvider } from "./model-config.ts";

function userBaseUrl(model: AnyModel, config: ModelsJsonProvider | undefined): string | undefined {
	const isChat = !isModelType(model, "image") && !isModelType(model, "classifier");
	const perModel = isChat ? config?.models?.find((entry) => entry.id === model.id)?.baseUrl : undefined;
	return perModel ?? config?.baseUrl;
}

/**
 * The last baseUrl-affecting composition step: a models.json `models[i].baseUrl`, else the provider
 * `baseUrl`, replaces whatever the extension, a native provider, or `oauth.modifyModels` set, for every
 * model type. Every transport, extension-supplied ones included, must send requests to `model.baseUrl`
 * (senpi#4765).
 */
export function applyUserBaseUrl(models: readonly AnyModel[], config: ModelsJsonProvider | undefined): AnyModel[] {
	return models.map((model) => {
		const baseUrl = userBaseUrl(model, config);
		return baseUrl === undefined || model.baseUrl === baseUrl ? model : { ...model, baseUrl };
	});
}
