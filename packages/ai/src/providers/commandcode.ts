import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { type CommandCodeApi, getCommandCodeModelsFromCatalog, loadCommandCodeCatalog } from "./commandcode-config.ts";
import { COMMANDCODE_MODELS } from "./commandcode.models.ts";

/**
 * Command Code provider with a generated baseline catalog and a live `/models`
 * refresh: the same split Radius uses, because the gateway publishes the model
 * list, its endpoint routing and its context length but not its prices. Costs,
 * reasoning metadata and input modalities come from the baseline; routing comes
 * from `/models` on every refresh.
 */
export function commandCodeProvider(): Provider<CommandCodeApi> {
	const baselineModels = Object.values(COMMANDCODE_MODELS) as Model<CommandCodeApi>[];
	const baselineById = new Map(baselineModels.map((model) => [model.id, model]));
	let dynamicModels: Model<CommandCodeApi>[] = [];
	const streams = {
		"anthropic-messages": anthropicMessagesApi(),
		"openai-completions": openAICompletionsApi(),
	} as const;

	return {
		id: "commandcode",
		name: "Command Code",
		auth: {
			apiKey: envApiKeyAuth("Command Code API key", ["CMD_API_KEY", "COMMANDCODE_API_KEY"]),
		},
		getModels: () => (dynamicModels.length > 0 ? [...dynamicModels] : [...baselineModels]),
		refreshModels: async (context) => {
			const stored = context.stored;
			if (stored) {
				const restored = stored.models.filter(
					(model) => model.provider === "commandcode",
				) as Model<CommandCodeApi>[];
				if (
					!(await context.publish({
						update: () => {
							dynamicModels = restored;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted) return;
			const catalog = await loadCommandCodeCatalog(context.signal);
			if (context.signal.aborted) return;
			const refreshed = getCommandCodeModelsFromCatalog("commandcode", catalog, (id) => baselineById.get(id));
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					dynamicModels = refreshed;
				},
			});
		},
		stream: (model, context, options) => streams[model.api].stream(model, context, options),
		streamSimple: (model, context, options) => streams[model.api].streamSimple(model, context, options),
	};
}
