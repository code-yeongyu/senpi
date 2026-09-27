/**
 * Meta's Muse Code subscription catalog, owned by the fork.
 *
 * models.dev does not describe this subscription provider, so a generation run
 * emits neither the shard nor a data file. Written by hand for the same reason
 * `kimi-coding.models.ts` is: a provider the fork ships must survive a catalog
 * regeneration that upstream cannot reproduce.
 */

import { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";

const values = {
	"muse-code-cli": {
		"muse-spark-1.3": {
			id: "muse-spark-1.3",
			name: "Muse Spark 1.3",
			api: "muse-code-cli",
			provider: "muse-code-subscription",
			baseUrl: "muse://local",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_007_997,
			maxTokens: 128_000,
		},
		"muse-spark-1.3-contributor": {
			id: "muse-spark-1.3-contributor",
			name: "Muse Spark 1.3 (contributor: content may be used for product improvement)",
			api: "muse-code-cli",
			provider: "muse-code-subscription",
			baseUrl: "muse://local",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_007_997,
			maxTokens: 128_000,
		},
		"muse-spark-1.2": {
			id: "muse-spark-1.2",
			name: "Muse Spark 1.2",
			api: "muse-code-cli",
			provider: "muse-code-subscription",
			baseUrl: "muse://local",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_007_997,
			maxTokens: 128_000,
		},
		"muse-spark-1.2-contributor": {
			id: "muse-spark-1.2-contributor",
			name: "Muse Spark 1.2 (contributor: content may be used for product improvement)",
			api: "muse-code-cli",
			provider: "muse-code-subscription",
			baseUrl: "muse://local",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_007_997,
			maxTokens: 128_000,
		},
	},
} as const;

export const MUSE_CODE_SUBSCRIPTION_MODELS: ModelCatalog<typeof values, "muse-code-subscription"> =
	flattenModelCatalog("muse-code-subscription", values);
