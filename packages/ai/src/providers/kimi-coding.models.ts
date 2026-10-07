/**
 * Kimi's coding-plan catalog, owned by the fork.
 *
 * models.dev described this provider once and no longer does, so a generation run
 * emits neither the shard nor its data file. Written by hand for the same reason
 * `devin.models.ts` is: a provider the fork ships must survive a catalog
 * regeneration that upstream no longer describes.
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
	"anthropic-messages": {
		"chat:k3": {
			"type": "chat",
			"id": "k3",
			"name": "Kimi K3",
			"api": "anthropic-messages",
			"provider": "kimi-coding",
			"baseUrl": "https://api.kimi.com/coding",
			"compat": {
				"allowEmptySignature": true,
				"forceAdaptiveThinking": true
			},
			"reasoning": true,
			"thinkingLevelMap": {
				"off": null,
				"minimal": null,
				"low": "low",
				"medium": null,
				"high": "high",
				"xhigh": null,
				"max": "max"
			},
			"input": [
				"text",
				"image",
				"video"
			],
			"inputLimits": {
				"images": {
					"resize": { "maxWidth": 2000, "maxHeight": 2000, "maxBytes": 4718592, "jpegQuality": 80 }
				}
			},
			"cost": {
				"input": 3,
				"output": 15,
				"cacheRead": 0.3,
				"cacheWrite": 0
			},
			"contextWindow": 1048576,
			"maxTokens": 131072
		},
		"chat:k3-256k": {
			"type": "chat",
			"id": "k3-256k",
			"name": "Kimi K3-256K",
			"api": "anthropic-messages",
			"provider": "kimi-coding",
			"baseUrl": "https://api.kimi.com/coding",
			"compat": {
				"forceAdaptiveThinking": true
			},
			"reasoning": true,
			"input": [
				"text",
				"image"
			],
			"inputLimits": {
				"images": {
					"resize": { "maxWidth": 2000, "maxHeight": 2000, "maxBytes": 4718592, "jpegQuality": 80 }
				}
			},
			"cost": {
				"input": 0,
				"output": 0,
				"cacheRead": 0,
				"cacheWrite": 0
			},
			"contextWindow": 262144,
			"maxTokens": 131072,
			"thinkingLevelMap": {
				"off": null,
				"minimal": null,
				"low": "low",
				"medium": null,
				"high": "high",
				"xhigh": null,
				"max": "max"
			}
		},
		"chat:kimi-for-coding": {
			"type": "chat",
			"id": "kimi-for-coding",
			"name": "kimi-for-coding",
			"api": "anthropic-messages",
			"provider": "kimi-coding",
			"baseUrl": "https://api.kimi.com/coding",
			"compat": {
				"allowEmptySignature": true,
				"forceAdaptiveThinking": true
			},
			"reasoning": true,
			"input": [
				"text",
				"image"
			],
			"inputLimits": {
				"images": {
					"resize": { "maxWidth": 2000, "maxHeight": 2000, "maxBytes": 4718592, "jpegQuality": 80 }
				}
			},
			"cost": {
				"input": 0.95,
				"output": 4,
				"cacheRead": 0.19,
				"cacheWrite": 0
			},
			"contextWindow": 1048576,
			"maxTokens": 32768,
			"thinkingLevelMap": {
				"off": null,
				"minimal": null,
				"low": "low",
				"medium": null,
				"high": "high",
				"xhigh": null,
				"max": "max"
			}
		},
		"chat:kimi-for-coding-highspeed": {
			"type": "chat",
			"id": "kimi-for-coding-highspeed",
			"name": "Kimi For Coding HighSpeed",
			"api": "anthropic-messages",
			"provider": "kimi-coding",
			"baseUrl": "https://api.kimi.com/coding",
			"compat": {
				"forceAdaptiveThinking": true
			},
			"reasoning": true,
			"input": [
				"text",
				"image"
			],
			"inputLimits": {
				"images": {
					"resize": { "maxWidth": 2000, "maxHeight": 2000, "maxBytes": 4718592, "jpegQuality": 80 }
				}
			},
			"cost": {
				"input": 1.9,
				"output": 8,
				"cacheRead": 0.38,
				"cacheWrite": 0
			},
			"contextWindow": 262144,
			"maxTokens": 32768
		},
		"chat:kimi-k2-thinking": {
			"type": "chat",
			"id": "kimi-k2-thinking",
			"name": "Kimi K2 Thinking",
			"api": "anthropic-messages",
			"provider": "kimi-coding",
			"baseUrl": "https://api.kimi.com/coding",
			"compat": {
				"forceAdaptiveThinking": true
			},
			"reasoning": true,
			"input": [
				"text"
			],
			"cost": {
				"input": 0.6,
				"output": 2.5,
				"cacheRead": 0.15,
				"cacheWrite": 0
			},
			"contextWindow": 262144,
			"maxTokens": 32768
		}
	}
} as const;

export const KIMI_CODING_MODELS: ChatModelCatalog<typeof values, "kimi-coding"> = flattenChatModelCatalog(
	"kimi-coding",
	values,
);

export const KIMI_CODING_IMAGE_MODELS: ImageModelCatalog<typeof values, "kimi-coding"> = flattenImageModelCatalog(
	"kimi-coding",
	values,
);

export const KIMI_CODING_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "kimi-coding"> =
	flattenClassifierModelCatalog("kimi-coding", values);
