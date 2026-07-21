import { MODELS } from "./models.generated.ts";
import type { Api, Model } from "./types.ts";

const XIAOMI_MIMO_PROVIDERS = new Set([
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
]);

function normalizeGeneratedModel<TApi extends Api>(model: Model<TApi> | undefined): Model<TApi> | undefined {
	if (!model) return undefined;
	if (XIAOMI_MIMO_PROVIDERS.has(model.provider) && model.id === "mimo-v2.5-pro") {
		return {
			...model,
			compat: {
				...model.compat,
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "deepseek",
				supportsDisabledThinking: false,
			},
		} as Model<TApi>;
	}
	if (model.provider === "anthropic" && model.id === "claude-opus-4-8") {
		return {
			...model,
			thinkingLevelMap: {
				...model.thinkingLevelMap,
				max: "max",
			},
		};
	}
	return model;
}

/** @deprecated Use `getBuiltinModel` from `providers/all.ts` or a Models runtime. */
export function getModel(provider: string, modelId: string): Model<any> {
	const providerModels = MODELS[provider as keyof typeof MODELS] as Record<string, Model<Api>> | undefined;
	const model = normalizeGeneratedModel(providerModels?.[modelId]);
	if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
	return model;
}

/** @deprecated Use `getBuiltinModels` from `providers/all.ts` or a Models runtime. */
export function getModels(provider: string): Model<any>[] {
	const providerModels = MODELS[provider as keyof typeof MODELS] as Record<string, Model<Api>> | undefined;
	return providerModels
		? Object.values(providerModels)
				.map((model) => normalizeGeneratedModel(model))
				.filter((model): model is Model<Api> => model !== undefined)
		: [];
}

/** @deprecated Use `getBuiltinProviders` from `providers/all.ts` or a Models runtime. */
export function getProviders(): string[] {
	return Object.keys(MODELS);
}
