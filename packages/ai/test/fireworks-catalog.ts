import { getModels } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

// The Fireworks catalog is regenerated from models.dev on every release, and models.dev
// retires Fireworks model ids often. Tests pick Fireworks models by the property they
// exercise, never by a literal id, so a retired model cannot fail the release typecheck.
// A shape upstream may stop shipping altogether (for example a Messages model without
// effort metadata) is tested on a model generated from a fixture catalog instead
// (fireworks-model-generation.test.ts), so retiring its last live row cannot fail the release.
export function fireworksMessagesModels(): Model<"anthropic-messages">[] {
	return getModels("fireworks").filter(
		(model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages",
	);
}

export function fireworksCompletionsModels(): Model<"openai-completions">[] {
	return getModels("fireworks").filter(
		(model): model is Model<"openai-completions"> => model.api === "openai-completions",
	);
}

export function requireModels<TApi extends Api>(models: Model<TApi>[], minimum: number): Model<TApi>[] {
	if (models.length < minimum) {
		throw new Error(`expected at least ${minimum} Fireworks models, the catalog has ${models.length}`);
	}
	return models;
}
