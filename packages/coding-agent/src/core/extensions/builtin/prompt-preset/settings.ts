import type { Settings, SettingsManager } from "../../../settings-manager.js";

export type PromptPresetName = "auto" | "sisyphus" | "hephaestus";

export interface PromptPresetSettings {
	promptPreset: PromptPresetName;
}

type SettingsWithPromptPreset = Settings & { promptPreset?: string };

function parsePromptPreset(value: string | undefined): PromptPresetName | undefined {
	if (value === "auto" || value === "sisyphus" || value === "hephaestus") {
		return value;
	}
	return undefined;
}

export function loadPromptPresetSettings(settingsManager: SettingsManager): PromptPresetSettings {
	const globalSettings = settingsManager.getGlobalSettings() as SettingsWithPromptPreset;
	const projectSettings = settingsManager.getProjectSettings() as SettingsWithPromptPreset;

	return {
		promptPreset:
			parsePromptPreset(projectSettings.promptPreset) ?? parsePromptPreset(globalSettings.promptPreset) ?? "auto",
	};
}
