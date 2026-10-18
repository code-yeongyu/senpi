import type { Api, Model, ThinkingLevelMap } from "./types.ts";

const GOOGLE_THINKING_APIS: Api[] = ["google-generative-ai", "google-vertex"];

/**
 * Generation 4 and later of this provider's models accept only the discrete low, medium and high
 * levels: a token budget, `minimal`, or turning thinking off is rejected with HTTP 400 (senpi#3292).
 */
const GENERATION_4_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

/** A complete id or a `models/`-style namespace, generation 4 or later, then the end or a `-` suffix. */
const GENERATION_4_ID = /(?:^|\/)gemini-(?:[4-9]|[1-9]\d)(?:\.\d+)?(?:-|$)/;

export function isGoogleGeneration4OrLaterModelId(modelId: string): boolean {
	return GENERATION_4_ID.test(modelId.toLowerCase());
}

/** The level map for a generation-4-or-later row that ships none; generated metadata always wins. */
export function inferGoogleThinkingLevelMap<TApi extends Api>(model: Model<TApi>): ThinkingLevelMap | undefined {
	if (model.thinkingLevelMap !== undefined) return model.thinkingLevelMap;
	if (GOOGLE_THINKING_APIS.includes(model.api) && isGoogleGeneration4OrLaterModelId(model.id)) {
		return GENERATION_4_THINKING_LEVEL_MAP;
	}
	return undefined;
}
