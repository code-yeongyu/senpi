import { flattenChatModelCatalog } from "../src/model-catalog.ts";
import type { Model, ThinkingLevelMap } from "../src/types.ts";

export const FIXTURE_MAX_MODEL_ID = "fixture-native-max-model";
export const FIXTURE_NO_MAX_MODEL_ID = "fixture-low-high-model";

function fixtureModel(id: string, thinkingLevelMap: ThinkingLevelMap): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "fixture-catalog",
		type: "chat",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

/** Register synthetic rows through the same flattening seam used by every built-in catalog. */
export function installMaxEffortFixtureCatalog(): void {
	flattenChatModelCatalog("fixture-catalog", {
		"openai-completions": {
			[`chat:${FIXTURE_MAX_MODEL_ID}`]: fixtureModel(FIXTURE_MAX_MODEL_ID, {
				low: "low",
				high: "high",
				max: "max",
			}),
			[`chat:${FIXTURE_NO_MAX_MODEL_ID}`]: fixtureModel(FIXTURE_NO_MAX_MODEL_ID, {
				low: "low",
				high: "high",
				max: null,
			}),
		},
	});
}
