import type { CompactionPreparation } from "../../src/core/compaction/compaction.ts";
import type { ExtensionSessionSettings } from "../../src/core/extensions/types.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/** Hard-limit test settings; `toolAdmissionEnabled: false` pins the pre-admission blocking path. */
export const HARD_LIMIT_SETTINGS: CompactionPreparation["settings"] = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
	toolAdmissionEnabled: false,
};

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
