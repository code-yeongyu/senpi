import { fetchDevinModels } from "../api/devin-agent/discovery.ts";
import { DEVIN_DEFAULT_BASE_URL } from "../api/devin-agent/paths.ts";
import { devinAgentApi } from "../api/devin-agent.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadDevinOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { DEVIN_MODELS } from "./devin.models.ts";

/**
 * Devin (Cognition) Cascade provider.
 *
 * Auth is the CLI session token minted by the Devin OAuth flow. Cascade's
 * catalog is credential-scoped, so the static seed is a floor rather than the
 * truth: once a credential exists, `refreshModels` replaces it with the
 * account's real lanes and KEEPS the seed whenever discovery fails or reports
 * nothing, because publishing an empty catalog would strip a working provider.
 */
export function devinProvider(): Provider<"devin-agent"> {
	let models: Model<"devin-agent">[] = DEVIN_MODELS;

	const provider = createProvider<"devin-agent">({
		id: "devin",
		name: "Devin",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		auth: {
			oauth: lazyOAuth({ name: "Devin", loginLabel: "Sign in with Devin", load: loadDevinOAuth }),
		},
		models: DEVIN_MODELS,
		api: { "devin-agent": devinAgentApi() },
	});

	return {
		...provider,
		getModels: () => models,
		refreshModels: async (context) => {
			const stored = context.stored;
			if (stored) {
				const restored = stored.models.filter((model) => model.provider === "devin") as Model<"devin-agent">[];
				if (restored.length > 0) {
					await context.publish({
						update: () => {
							models = restored;
						},
					});
				}
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			const credential = context.credential;
			const apiKey = credential?.type === "oauth" ? credential.access : credential?.key;
			if (!apiKey) return;
			const discovered = await fetchDevinModels({ apiKey, baseUrl: DEVIN_DEFAULT_BASE_URL, signal: context.signal });
			if (!discovered || context.signal.aborted) return;
			await context.publish({
				persist: { models: discovered, checkedAt: Date.now() },
				update: () => {
					models = discovered;
				},
			});
		},
	};
}
