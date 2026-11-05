import type { ModelsJsonProvider } from "./model-config.ts";

/**
 * Providers whose transport cannot send requests to another address: the cursor-cli-oauth lane spawns the
 * Cursor CLI, which has no base-URL option (senpi#4765). Keyed by provider id; the value names the service.
 */
const FIXED_ADDRESS_PROVIDERS: ReadonlyMap<string, string> = new Map([["cursor-cli-oauth", "Cursor"]]);

function setsBaseUrl(config: ModelsJsonProvider): boolean {
	return config.baseUrl !== undefined || (config.models ?? []).some((model) => model.baseUrl !== undefined);
}

/**
 * One notice per fixed-address provider whose models.json entry sets a `baseUrl` (provider-level or
 * `models[i].baseUrl`): the setting is kept, but requests still go to the provider's own service.
 */
export function fixedAddressBaseUrlNotices(providers: ReadonlyMap<string, ModelsJsonProvider>): string[] {
	const notices: string[] = [];
	for (const [providerId, service] of FIXED_ADDRESS_PROVIDERS) {
		const config = providers.get(providerId);
		if (config === undefined || !setsBaseUrl(config)) continue;
		notices.push(
			`models.json sets a baseUrl for ${providerId}, but ${service} does not support changing the address. Requests still go to ${service}.`,
		);
	}
	return notices;
}
