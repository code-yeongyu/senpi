import type { Settings, SettingsManager } from "../../../settings-manager.ts";

export type PromptPresetName =
	| "auto"
	| "claude-fable-5"
	| "claude-fable-5-1"
	| "claude-opus-5"
	| "claude-opus-4-8"
	| "claude-opus-4-7"
	| "claude-opus-4-6"
	| "claude-opus-4-5"
	| "deepseek-v4-flash"
	| "deepseek-v4-flash-0731"
	| "deepseek-v4-pro"
	| "glm-5.2"
	| "glm-5.3"
	| "grok-4.5"
	| "grok-4.6"
	| "kimi-k3"
	| "kimi-k2-7"
	| "kimi-k2-6"
	| "gpt-5"
	| "gpt-5.2"
	| "gpt-5.3-codex"
	| "gpt-5.4"
	| "gpt-5.5"
	| "gpt-5.6"
	| "gpt-6-astra";

export interface PromptPresetSettings {
	promptPreset: PromptPresetName;
}

type SettingsWithPromptPreset = Settings & { promptPreset?: string };

const VALID_PRESETS: ReadonlySet<string> = new Set<PromptPresetName>([
	"auto",
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-5",
	"deepseek-v4-flash",
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"glm-5.2",
	"glm-5.3",
	"grok-4.5",
	"grok-4.6",
	"kimi-k3",
	"kimi-k2-7",
	"kimi-k2-6",
	"gpt-5",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-6-astra",
]);

export function parsePromptPreset(value: string | undefined): PromptPresetName | undefined {
	if (value && VALID_PRESETS.has(value)) {
		return value as PromptPresetName;
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
