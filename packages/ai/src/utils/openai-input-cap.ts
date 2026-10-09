import type { Api, Model } from "../types.ts";

const DOCUMENTED_INPUT_CAPS: ReadonlyMap<number, number> = new Map([
	[400000, 272000],
	[1050000, 922000],
]);
const GATEWAY_ID_PREFIX = /^(?:[a-z]{2}\.)?(?:global\.)?openai[./]/;

/** OpenAI's input/output split follows GPT-5/6 models across gateway providers. */
export function applyOpenAiInputCap(model: Model<Api>): void {
	const bare = model.id.replace(GATEWAY_ID_PREFIX, "");
	if (!/^gpt-(?:5|6)(?:[.-]|$)/.test(bare)) return;
	// Historical models.dev output metadata duplicated GPT-5 Pro's input sub-limit.
	if (bare === "gpt-5-pro" && model.maxTokens === 272000) model.maxTokens = 128000;
	if (model.maxTokens === 128000) {
		model.contextWindow = DOCUMENTED_INPUT_CAPS.get(model.contextWindow) ?? model.contextWindow;
	}
}
