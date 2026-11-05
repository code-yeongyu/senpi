import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type FastPairRegistry, fastSiblingOption, findFastModel } from "../../src/core/fast-model-pair.ts";
import { resolveChainKey } from "../../src/core/retry-fallback/chains.ts";

const base = getModel("openai", "gpt-5.4");
const fast: Model<Api> = { ...base, id: "gpt-5.4-fast", name: "GPT-5.4 Fast" };
const otherProviderFast: Model<Api> = { ...fast, provider: "other" };
const FALLBACK = ["anthropic/claude-sonnet-4-5"];

function registry(
	models: readonly Model<Api>[],
	catalog: Record<string, { upstream?: string; tier?: string }>,
): FastPairRegistry {
	return {
		find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		getUpstreamModelId: (model) => catalog[`${model.provider}/${model.id}`]?.upstream,
		getServiceTier: (model) => catalog[`${model.provider}/${model.id}`]?.tier,
	};
}

const paired = registry([base, fast], { "openai/gpt-5.4-fast": { upstream: "gpt-5.4", tier: "priority" } });

describe("a base model's chain key falls back to its -fast sibling's key only", () => {
	it("#given keys for both the model and its -fast sibling #then the model's own key wins", () => {
		const chains = { "openai/gpt-5.4-fast": FALLBACK, "openai/gpt-5.4": ["openai/gpt-5.4-mini"] };
		expect(resolveChainKey(base, undefined, chains, fastSiblingOption(paired, base))).toBe("openai/gpt-5.4");
	});

	it("#given only the -fast sibling's key #then the sibling's key governs, thinking level first", () => {
		const chains = { "openai/gpt-5.4-fast": FALLBACK, "openai/gpt-5.4-fast:low": ["openai/gpt-5.4-mini"] };
		const option = fastSiblingOption(paired, base);
		expect(resolveChainKey(base, "low", chains, option)).toBe("openai/gpt-5.4-fast:low");
		expect(resolveChainKey(base, "high", chains, option)).toBe("openai/gpt-5.4-fast");
	});

	it("#given a model with no paired sibling #then no key resolves", () => {
		const chains = { "openai/gpt-5.4-fast": FALLBACK };
		const unpaired = [
			registry([base], {}),
			registry([base, fast], { "openai/gpt-5.4-fast": { upstream: "gpt-5.4" } }),
			registry([base, fast], { "openai/gpt-5.4-fast": { upstream: "gpt-5.5", tier: "priority" } }),
		];
		for (const catalog of unpaired) {
			expect(resolveChainKey(base, undefined, chains, fastSiblingOption(catalog, base))).toBeUndefined();
		}
	});

	it("#given a registry without the catalog reads #then no sibling is paired", () => {
		expect(fastSiblingOption({ find: paired.find }, base)).toEqual({});
	});

	it("#given a sibling on another provider #then it never lends its key", () => {
		const chains = { "other/gpt-5.4-fast": FALLBACK };
		expect(resolveChainKey(base, undefined, chains, { fastSibling: otherProviderFast })).toBeUndefined();
		expect(findFastModel(registry([base, otherProviderFast], {}), base)).toBeUndefined();
	});

	it("#given the session already runs on the -fast model #then only its own key is read", () => {
		expect(findFastModel(paired, fast)).toBeUndefined();
		expect(
			resolveChainKey(fast, undefined, { "openai/gpt-5.4": FALLBACK }, fastSiblingOption(paired, fast)),
		).toBeUndefined();
	});
});
