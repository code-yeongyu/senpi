import type { ExtensionSessionSettings, RetryFallbackSettings } from "../../types.ts";

export type FallbackSettings = RetryFallbackSettings;

export function loadFallbackSettings(settings: ExtensionSessionSettings): FallbackSettings {
	return settings.getRetryFallbackSettings();
}

export async function updateFallbackSettings(
	settings: ExtensionSessionSettings,
	update: (settings: ExtensionSessionSettings) => Promise<void>,
): Promise<FallbackSettings> {
	await update(settings);
	return settings.getRetryFallbackSettings();
}

export function isModelFallbackDisabled(flag: boolean | string | undefined, environment = process.env): boolean {
	return flag === true || environment.SENPI_NO_FALLBACK === "1";
}
