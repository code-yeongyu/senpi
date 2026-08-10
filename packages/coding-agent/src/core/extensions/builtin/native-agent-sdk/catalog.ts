import { getModels } from "@earendil-works/pi-ai/compat";

type CatalogProvider = Parameters<typeof getModels>[0];

export function sdkCatalog(provider: CatalogProvider, include?: (modelId: string) => boolean) {
	return getModels(provider)
		.filter((model) => include?.(model.id) ?? true)
		.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			thinkingLevelMap: model.thinkingLevelMap,
		}));
}
