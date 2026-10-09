import type { Model, ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import { registerPromptCacheWarmer } from "./prompt-cache-warmers.ts";

export const openAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-responses.ts"));

registerPromptCacheWarmer("openai-responses", async (model, context, options) => {
	const { warmOpenAIResponsesPromptCache } = await import("./openai-responses.ts");
	return warmOpenAIResponsesPromptCache(model as Model<"openai-responses">, context, options);
});
