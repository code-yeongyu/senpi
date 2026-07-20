import type { ExtensionSessionSettings } from "../../src/core/extensions/types.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/** Creates an isolated, in-memory settings facade for extension context fixtures. */
export function createInMemoryExtensionSessionSettings(): ExtensionSessionSettings {
	const settings = SettingsManager.inMemory();
	return {
		getRetryFallbackSettings: () => settings.getRetryFallbackSettings(),
		setFallbackChain: async (key, entries) => {
			settings.setFallbackChain(key, [...entries]);
			await settings.flush();
		},
		removeFallbackChain: async (key) => {
			settings.removeFallbackChain(key);
			await settings.flush();
		},
		setModelFallbackEnabled: async (enabled) => {
			settings.setModelFallbackEnabled(enabled);
			await settings.flush();
		},
		setFallbackRevertPolicy: async (policy) => {
			settings.setFallbackRevertPolicy(policy);
			await settings.flush();
		},
		reload: () => settings.reload(),
		getFallbackStatus: () => undefined,
	};
}
