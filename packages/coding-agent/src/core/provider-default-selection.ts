import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStatus } from "./provider-composer.ts";

export interface ProviderAuthStatusSource {
	getProviderAuthStatus?(providerId: string): AuthStatus;
}

export interface ProviderDefaultSelection {
	model: Model<Api>;
	provenance: "provider-default" | "first-available";
}

/**
 * True when a provider is available only through a shared cloud credential chain (ambient AWS
 * env, Google ADC). Such a provider stays selectable but never outranks one the user configured
 * (senpi#2327). Compatibility sources without auth status report every provider as configured.
 */
export function isAmbientOnlyProvider(source: ProviderAuthStatusSource, providerId: string): boolean {
	return source.getProviderAuthStatus?.(providerId).ambient === true;
}

export function createAmbientProviderCheck(source: ProviderAuthStatusSource): (providerId: string) => boolean {
	const cache = new Map<string, boolean>();
	return (providerId) => {
		let ambient = cache.get(providerId);
		if (ambient === undefined) {
			ambient = isAmbientOnlyProvider(source, providerId);
			cache.set(providerId, ambient);
		}
		return ambient;
	};
}

/**
 * The automatic default among available models. Models from providers the user configured are
 * considered first; ambient-only providers only when nothing else is available. Within that group
 * the first `providerDefaults` entry (declared order) that is available wins, else the group's
 * first available model.
 */
export function selectProviderDefault(
	availableModels: readonly Model<Api>[],
	providerDefaults: Readonly<Record<string, string>>,
	source: ProviderAuthStatusSource,
): ProviderDefaultSelection | undefined {
	const isAmbient = createAmbientProviderCheck(source);
	const configured = availableModels.filter((model) => !isAmbient(model.provider));
	const group = configured.length > 0 ? configured : availableModels;
	for (const [provider, modelId] of Object.entries(providerDefaults)) {
		const match = group.find((model) => model.provider === provider && model.id === modelId);
		if (match) return { model: match, provenance: "provider-default" };
	}
	const first = group[0];
	return first ? { model: first, provenance: "first-available" } : undefined;
}
