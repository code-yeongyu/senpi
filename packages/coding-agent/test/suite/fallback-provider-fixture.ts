import type { Harness } from "./harness.ts";

/** Keep the scripted faux transport while placing fallback models on another account. */
export function registerFallbackModels(harness: Harness, provider: string, ids: readonly string[]): void {
	const models = ids.map((id) => {
		const model = harness.getModel(id);
		if (!model) throw new Error(`Missing fallback fixture: ${id}`);
		return model;
	});
	const first = models[0];
	if (!first) throw new Error("Fallback fixture needs a model");
	harness.modelRegistry.registerProvider(provider, {
		api: first.api,
		apiKey: "faux-key",
		baseUrl: first.baseUrl,
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
		})),
	});
}
