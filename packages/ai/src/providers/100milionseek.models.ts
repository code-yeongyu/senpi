/**
 * 100milionseek's catalog, owned by the fork.
 *
 * The service exposes an OpenAI-compatible endpoint but is not described by
 * models.dev. Keep the shipped row here so a catalog regeneration cannot make
 * the provider or its model disappear.
 */

import {
	type ChatModelCatalog,
	type ClassifierModelCatalog,
	flattenChatModelCatalog,
	flattenClassifierModelCatalog,
	flattenImageModelCatalog,
	type ImageModelCatalog,
} from "../model-catalog.ts";

const values = {
	"openai-completions": {
		"chat:deepseek-v4.1-flash-free": {
			"type": "chat",
			"id": "deepseek-v4.1-flash-free",
			"name": "DeepSeek V4.1 Flash Free",
			"api": "openai-completions",
			"provider": "100milionseek",
			"baseUrl": "https://100milionseek.top/v1",
			"reasoning": false,
			"input": ["text"],
			"cost": {
				"input": 0,
				"output": 0,
				"cacheRead": 0,
				"cacheWrite": 0
			},
			"contextWindow": 198000,
			"maxTokens": 64000,
			"compat": {
				"supportsDeveloperRole": false,
				"supportsReasoningEffort": false,
				"maxTokensField": "max_tokens"
			}
		}
	}
};

export const ONE_HUNDRED_MILIONSEEK_MODELS: ChatModelCatalog<typeof values, "100milionseek"> =
	flattenChatModelCatalog("100milionseek", values);

export const ONE_HUNDRED_MILIONSEEK_IMAGE_MODELS: ImageModelCatalog<typeof values, "100milionseek"> =
	flattenImageModelCatalog("100milionseek", values);

export const ONE_HUNDRED_MILIONSEEK_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "100milionseek"> =
	flattenClassifierModelCatalog("100milionseek", values);
