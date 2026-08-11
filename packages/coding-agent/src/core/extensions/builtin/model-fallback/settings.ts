import type { Api, Model } from "@earendil-works/pi-ai";
import { canonicalizeFallbackChains, type FallbackModelLookup } from "../../../retry-fallback/chains.ts";
import type { ExtensionSessionSettings, RetryFallbackSettings } from "../../types.ts";

export type FallbackSettings = RetryFallbackSettings;

/**
 * `/fallback` shows what the user can act on. A bare default expands across every
 * provider in the builtin catalog that publishes the model, so canonicalizing
 * against the full registry listed chains for providers the user cannot select
 * (no credentials). Scope the display to selectable models; the runtime keeps
 * using the full registry so a chain still resolves for the active model.
 */
function displayLookup(models: FallbackModelLookup): FallbackModelLookup {
	if (Array.isArray(models)) return models;
	const registry = models as {
		getAll(): Model<Api>[];
		getAvailable?(): Model<Api>[];
		isUsingOAuth?(model: Model<Api>): boolean;
		hasConfiguredAuth?(model: Model<Api>): boolean;
	};
	if (typeof registry.getAvailable !== "function") return models;
	const available = registry.getAvailable();
	return {
		getAll: () => (available.length > 0 ? available : registry.getAll()),
		isUsingOAuth: (model) => registry.isUsingOAuth?.(model) === true,
		hasConfiguredAuth: (model) => registry.hasConfiguredAuth?.(model) === true,
	};
}

function withAvailableChains(settings: FallbackSettings, models: FallbackModelLookup): FallbackSettings {
	return {
		...settings,
		chains: canonicalizeFallbackChains(settings.chains, displayLookup(models)),
	};
}

export function loadFallbackSettings(
	settings: ExtensionSessionSettings,
	models: FallbackModelLookup,
): FallbackSettings {
	return withAvailableChains(settings.getRetryFallbackSettings(), models);
}

export async function updateFallbackSettings(
	settings: ExtensionSessionSettings,
	models: FallbackModelLookup,
	update: (settings: ExtensionSessionSettings) => Promise<void>,
): Promise<FallbackSettings> {
	await update(settings);
	return withAvailableChains(settings.getRetryFallbackSettings(), models);
}

export function isModelFallbackDisabled(flag: boolean | string | undefined, environment = process.env): boolean {
	return flag === true || environment.SENPI_NO_FALLBACK === "1";
}
