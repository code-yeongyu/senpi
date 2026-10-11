import {
	extractClaudeOpusVersion,
	extractGpt5Version,
	isClaudeFable5Model,
	isClaudeFable51Model,
	isClaudeHaiku55Model,
	isClaudeOpus5Model,
	isClaudeOpus55Model,
	isClaudeSonnet55Model,
	isDeepseekV4Flash0731Model,
	isDeepseekV4FlashModel,
	isDeepseekV4ProModel,
	isDeepseekV41FlashModel,
	isGlm52Model,
	isGlm53Model,
	isGpt6FamilyModel,
	isGrok45Model,
	isGrok46Model,
	isGrok47Model,
	isKimiK3Model,
	isKimiK26Model,
	isKimiK27Model,
	isKimiK28Model,
	isSWE2Model,
	type ModelWithPromptPresetMetadata,
} from "./matchers.ts";
import type { PromptPresetName } from "./settings.ts";

export type ResolvedPresetName = Exclude<PromptPresetName, "auto">;

export function resolvePresetName(input: {
	providerID: string;
	modelID: string;
	name?: string;
}): ResolvedPresetName | undefined {
	const model: ModelWithPromptPresetMetadata = { id: input.modelID, provider: input.providerID, name: input.name };
	if (isGpt6FamilyModel(model)) {
		return "gpt-6-astra";
	}
	const gpt5Version = extractGpt5Version(model.id);
	if (gpt5Version) {
		return gpt5Version;
	}
	if (isSWE2Model(model) || isKimiK3Model(model)) {
		return "kimi-k3";
	}
	if (isKimiK28Model(model)) {
		return "kimi-k2-8";
	}
	if (isKimiK27Model(model)) {
		return "kimi-k2-7";
	}
	if (isKimiK26Model(model)) {
		return "kimi-k2-6";
	}
	// The dotted release must resolve before the generic fable-5 substring.
	if (isClaudeFable51Model(model.id)) {
		return "claude-fable-5-1";
	}
	if (isClaudeFable5Model(model.id)) {
		return "claude-fable-5";
	}
	// The dotted release must resolve before the generic opus-5 substring.
	if (isClaudeOpus55Model(model.id)) {
		return "claude-opus-5-5";
	}
	if (isClaudeOpus5Model(model.id)) {
		return "claude-opus-5";
	}
	if (isClaudeSonnet55Model(model.id)) {
		return "claude-sonnet-5-5";
	}
	if (isClaudeHaiku55Model(model.id)) {
		return "claude-haiku-5-5";
	}
	const claudeVersion = extractClaudeOpusVersion(model.id);
	if (claudeVersion) {
		return claudeVersion;
	}
	if (isGlm53Model(model)) {
		return "glm-5.3";
	}
	if (isGlm52Model(model)) {
		return "glm-5.2";
	}
	// The dated snapshot must resolve before the generic flash alias.
	if (isDeepseekV4Flash0731Model(model)) {
		return "deepseek-v4-flash-0731";
	}
	if (isDeepseekV41FlashModel(model)) {
		return "deepseek-v4-1-flash";
	}
	if (isDeepseekV4FlashModel(model)) {
		return "deepseek-v4-flash";
	}
	if (isDeepseekV4ProModel(model)) {
		return "deepseek-v4-pro";
	}
	if (isGrok47Model(model)) {
		return "grok-4.7";
	}
	if (isGrok46Model(model)) {
		return "grok-4.6";
	}
	if (isGrok45Model(model)) {
		return "grok-4.5";
	}
	return undefined;
}

export type PromptPresetModelCase = {
	readonly providerID: string;
	readonly modelID: string;
	readonly preset: ResolvedPresetName;
};

export const PROMPT_PRESET_MODEL_CASES: readonly PromptPresetModelCase[] = [
	{ providerID: "openai", modelID: "gpt-6-astra", preset: "gpt-6-astra" },
	{ providerID: "openai", modelID: "gpt-5.6", preset: "gpt-5.6" },
	{ providerID: "openai", modelID: "gpt-5.5", preset: "gpt-5.5" },
	{ providerID: "openai", modelID: "gpt-5.4", preset: "gpt-5.4" },
	{ providerID: "openai", modelID: "gpt-5.3-codex", preset: "gpt-5.3-codex" },
	{ providerID: "openai", modelID: "gpt-5.2", preset: "gpt-5.2" },
	{ providerID: "moonshotai", modelID: "kimi-k3", preset: "kimi-k3" },
	{ providerID: "kimi-for-coding", modelID: "kimi-for-coding", preset: "kimi-k2-8" },
	{ providerID: "kimi-for-coding", modelID: "kimi-for-coding-highspeed", preset: "kimi-k2-7" },
	{ providerID: "moonshotai", modelID: "kimi-k2.6", preset: "kimi-k2-6" },
	{ providerID: "zai-coding-plan", modelID: "glm-5.3", preset: "glm-5.3" },
	{ providerID: "zai-coding-plan", modelID: "glm-5.2", preset: "glm-5.2" },
	{ providerID: "deepseek", modelID: "deepseek-v4-flash-0731", preset: "deepseek-v4-flash-0731" },
	{ providerID: "deepseek", modelID: "deepseek-flash", preset: "deepseek-v4-1-flash" },
	{ providerID: "fireworks", modelID: "accounts/fireworks/models/deepseek-v4-flash", preset: "deepseek-v4-flash" },
	{ providerID: "deepseek", modelID: "deepseek-v4-pro", preset: "deepseek-v4-pro" },
	{ providerID: "anthropic", modelID: "claude-fable-5", preset: "claude-fable-5" },
	{ providerID: "anthropic", modelID: "claude-fable-5.1", preset: "claude-fable-5-1" },
	{ providerID: "anthropic", modelID: "claude-opus-5.5", preset: "claude-opus-5-5" },
	{ providerID: "anthropic", modelID: "claude-opus-5", preset: "claude-opus-5" },
	{ providerID: "anthropic", modelID: "claude-sonnet-5.5", preset: "claude-sonnet-5-5" },
	{ providerID: "anthropic", modelID: "claude-haiku-5.5", preset: "claude-haiku-5-5" },
	{ providerID: "anthropic", modelID: "claude-opus-4-8", preset: "claude-opus-4-8" },
	{ providerID: "anthropic", modelID: "claude-opus-4-7", preset: "claude-opus-4-7" },
	{ providerID: "anthropic", modelID: "claude-opus-4-6", preset: "claude-opus-4-6" },
	{ providerID: "anthropic", modelID: "claude-opus-4-5", preset: "claude-opus-4-5" },
	{ providerID: "xai", modelID: "grok-4.7", preset: "grok-4.7" },
	{ providerID: "xai", modelID: "grok-4.6", preset: "grok-4.6" },
	{ providerID: "xai", modelID: "grok-4.5", preset: "grok-4.5" },
];

// Presets a model id can auto-resolve to. gpt-5 is a manual-only preset (settings union +
// buildPreset, no model matcher), so it is intentionally absent here: a model-driven parity check
// can only cover ids that resolve to a preset, and no real id auto-resolves to bare gpt-5.
export const AUTO_RESOLVED_PRESET_NAMES: readonly ResolvedPresetName[] = [
	"gpt-6-astra",
	"gpt-5.6",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.3-codex",
	"gpt-5.2",
	"kimi-k3",
	"kimi-k2-8",
	"kimi-k2-7",
	"kimi-k2-6",
	"glm-5.3",
	"glm-5.2",
	"deepseek-v4-flash-0731",
	"deepseek-v4-1-flash",
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"grok-4.7",
	"grok-4.6",
	"grok-4.5",
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-5",
];
