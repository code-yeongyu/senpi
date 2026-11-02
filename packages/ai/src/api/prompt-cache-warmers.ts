import type { Api, Context, Model, SimpleStreamOptions, Usage } from "../types.ts";

/**
 * Provider prompt-cache prewarm implementations keyed by api (senpi#2096). Each
 * `.lazy.ts` wrapper registers its own warmer so `warmPromptCache` reaches a
 * provider SDK only when the app already selected that provider.
 */
export type PromptCacheWarmer = (
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
) => Promise<{ usage: Usage; usageRaw: unknown }>;

const warmers = new Map<Api, PromptCacheWarmer>();

export function registerPromptCacheWarmer(api: Api, warmer: PromptCacheWarmer): void {
	warmers.set(api, warmer);
}

export function getPromptCacheWarmer(api: Api): PromptCacheWarmer | undefined {
	return warmers.get(api);
}
