import type { Api, Model } from "@earendil-works/pi-ai";

export type ModelWithPromptPresetMetadata = Pick<Model<Api>, "id" | "provider"> & {
	name?: string;
	promptPreset?: string;
};

export function normalizeModelId(modelId: string): string {
	return modelId.toLowerCase().replace(/\s+/g, "-");
}

// The GPT-6 family (Astra, 6.1 Sol, Sol, Luna) shares one prompting guide
// (developers.openai.com/api/docs/guides/latest-model, 2026-09-23; GPT-6.1 Sol added
// 2026-09-29), so every tier renders the gpt-6-astra preset; the preset keeps that name
// because settings.json already pins it. Id shapes verified against the OpenAI model
// pages, codex's models.json, models.dev, OpenRouter, Vercel and Bedrock's catalog:
// gpt-6-sol, gpt-6.1-sol, gpt-6.1-sol-fast, gpt-6-luna-fast, dated snapshots,
// openai/gpt-6-sol, openai/gpt-6.1-sol, openai-gpt-6-luna, global.openai.gpt-6-astra, Venice's
// dotless openai-gpt-61-sol (it spells every point release that way: openai-gpt-56-sol), and
// the display names "GPT-6 Sol" / "GPT-6.1 Sol" / "GPT-6 Luna". Bare "gpt-6", "gpt-6.1",
// "gpt-61", "gpt-6-mini" and a lone tier word stay out: an unknown sibling deserves its own
// decision, and the dotless form is accepted only with a single digit right after the 6.
export function hasGpt6FamilySignal(value: string): boolean {
	return /(?:^|[/@:._-])gpt[._-]?6(?:[._-]\d+|\d)?[._-](?:astra|sol|luna)(?:$|[/@:._-])/.test(normalizeModelId(value));
}

export function isGpt6FamilyModel(model: ModelWithPromptPresetMetadata): boolean {
	return hasGpt6FamilySignal(model.id) || (model.name !== undefined && hasGpt6FamilySignal(model.name));
}

export type Gpt5Version = "gpt-5.2" | "gpt-5.3-codex" | "gpt-5.4" | "gpt-5.5" | "gpt-5.6";

export function extractGpt5Version(modelId: string): Gpt5Version | undefined {
	const normalized = normalizeModelId(modelId);
	if (normalized.includes("gpt-5.6")) {
		return "gpt-5.6";
	}
	if (normalized.includes("gpt-5.5")) {
		return "gpt-5.5";
	}
	if (normalized.includes("gpt-5.4")) {
		return "gpt-5.4";
	}
	if (normalized.includes("gpt-5.3")) {
		return "gpt-5.3-codex";
	}
	if (normalized.includes("gpt-5.2")) {
		return "gpt-5.2";
	}
	return undefined;
}

export function hasKimiK26Signal(value: string): boolean {
	return /(?:^|[/@._-])kimi-k2(?:[._-]|p)6(?:$|[/@._:-])/.test(normalizeModelId(value));
}

export function isKimiK26Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK26Signal(model.id) || (model.name !== undefined && hasKimiK26Signal(model.name));
}

// Kimi Code addresses its models by rolling product ids rather than version tags:
// Moonshot upgraded `kimi-for-coding` to K2.8 Preview in place on 2026-09-11 and
// left `kimi-for-coding-highspeed` on K2.7 Code HighSpeed.
// https://www.kimi.com/code/docs/en/kimi-code/models.html (checked 2026-09-18)
export const KIMI_CODE_K27_MODEL_ID = "kimi-for-coding-highspeed";
export const KIMI_CODE_K28_MODEL_ID = "kimi-for-coding";

export function hasKimiK27Signal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return normalized === KIMI_CODE_K27_MODEL_ID || /(?:^|[/@._-])kimi-k2(?:[._-]|p)7(?:$|[/@._:-])/.test(normalized);
}

export function isKimiK27Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK27Signal(model.id) || (model.name !== undefined && hasKimiK27Signal(model.name));
}

export function hasKimiK28Signal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return normalized === KIMI_CODE_K28_MODEL_ID || /(?:^|[/@._-])kimi-k2(?:[._-]|p)8(?:$|[/@._:-])/.test(normalized);
}

export function isKimiK28Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK28Signal(model.id) || (model.name !== undefined && hasKimiK28Signal(model.name));
}

export function hasKimiK3Signal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return normalized === "k3" || /(?:^|[/@._-])kimi-k3(?:$|[/@._:-])/.test(normalized);
}

export function isKimiK3Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK3Signal(model.id) || (model.name !== undefined && hasKimiK3Signal(model.name));
}

// Exactly the SWE-2 lanes Devin's Cascade serves; every other swe-2 uid is refused upstream (#2306).
export function hasSWE2Signal(value: string): boolean {
	return /(?:^|[/@:._-])swe-2-(?:medium|high|max)(?:$|[/@:._])/.test(normalizeModelId(value));
}

export function isSWE2Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasSWE2Signal(model.id) || (model.name !== undefined && hasSWE2Signal(model.name));
}

// DeepSeek V4 id shapes verified against the OpenRouter live API, models.dev,
// and senpi's generated provider catalogs (2026-07-31): deepseek-v4-flash,
// deepseek/deepseek-v4-flash-0731, deepseek-ai/DeepSeek-V4-Pro,
// accounts/fireworks/models/deepseek-v4-flash, aihubmix's alicloud-deepseek-v4-*,
// and trailing tags (:free, -free, :thinking, -nothinking, -cheaper, -lightning, -el).
export function hasDeepseekV4Flash0731Signal(value: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash[._-]0731(?:$|[/@:._-])/.test(normalizeModelId(value));
}

export function isDeepseekV4Flash0731Model(model: ModelWithPromptPresetMetadata): boolean {
	return (
		hasDeepseekV4Flash0731Signal(model.id) || (model.name !== undefined && hasDeepseekV4Flash0731Signal(model.name))
	);
}

export function hasDeepseekV4FlashSignal(value: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash(?:$|[/@:._-])/.test(normalizeModelId(value));
}

export function isDeepseekV4FlashModel(model: ModelWithPromptPresetMetadata): boolean {
	return hasDeepseekV4FlashSignal(model.id) || (model.name !== undefined && hasDeepseekV4FlashSignal(model.name));
}

// DeepSeek V4.1 Flash id shapes verified against models.dev and the provider
// catalogs (2026-09-11): deepseek-flash (the official API name, also opencode-go),
// deepseek-v4.1-flash and deepseek/deepseek-v4.1-flash[:thinking] (OpenRouter,
// Vercel, requesty, kilo, ...), deepseek-ai/DeepSeek-V4.1-Flash (Hugging Face,
// DeepInfra), accounts/fireworks/models/deepseek-v4p1-flash, venice's
// deepseek-v4-1-flash, and the display name "DeepSeek V4.1 Flash".
export function hasDeepseekV41FlashSignal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return (
		/(?:^|[/@:._-])deepseek[._-]v4(?:[._-]1|p1)[._-]flash(?:$|[/@:._-])/.test(normalized) ||
		/(?:^|[/@:._-])deepseek[._-]flash(?:$|[/@:._-])/.test(normalized)
	);
}

export const DEEPSEEK_OFFICIAL_PROVIDER = "deepseek";

// DeepSeek retired V4 Flash on 2026-09-10: on the official API, deepseek-v4-flash
// and deepseek-v4-flash-vision-exp are served by V4.1 Flash. Every other
// provider still hosts the V4 weights under those names.
export function isRetiredOfficialDeepseekV4FlashAlias(model: ModelWithPromptPresetMetadata): boolean {
	return model.provider === DEEPSEEK_OFFICIAL_PROVIDER && hasDeepseekV4FlashSignal(model.id);
}

export function isDeepseekV41FlashModel(model: ModelWithPromptPresetMetadata): boolean {
	return (
		hasDeepseekV41FlashSignal(model.id) ||
		(model.name !== undefined && hasDeepseekV41FlashSignal(model.name)) ||
		isRetiredOfficialDeepseekV4FlashAlias(model)
	);
}

export function hasDeepseekV4ProSignal(value: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]pro(?:$|[/@:._-])/.test(normalizeModelId(value));
}

export function isDeepseekV4ProModel(model: ModelWithPromptPresetMetadata): boolean {
	return hasDeepseekV4ProSignal(model.id) || (model.name !== undefined && hasDeepseekV4ProSignal(model.name));
}

export function hasGlm52Signal(value: string): boolean {
	return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)2(?:$|[/@._:-])/.test(normalizeModelId(value));
}

export function isGlm52Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGlm52Signal(model.id) || (model.name !== undefined && hasGlm52Signal(model.name));
}

export function hasGlm53Signal(value: string): boolean {
	return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)3(?:$|[/@._:-])/.test(normalizeModelId(value));
}

export function isGlm53Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGlm53Signal(model.id) || (model.name !== undefined && hasGlm53Signal(model.name));
}

export function hasGrok45Signal(value: string): boolean {
	// Match any Grok 4.5 id shape: grok-4.5, grok4.5, grok45, grok-4p5, provider:model,
	// path/prefix ids, and trailing tags (:thinking, -latest). Keep 4.3 / 4.20 / 3 out.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?5(?:$|[/@._:-])/.test(normalizeModelId(value));
}

export function isGrok45Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGrok45Signal(model.id) || (model.name !== undefined && hasGrok45Signal(model.name));
}

export function hasGrok46Signal(value: string): boolean {
	// Same id shapes as hasGrok45Signal with a 4.6 minor version. Keep 4.5 / 4.3 / 4.20 / 3 out.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?6(?:$|[/@._:-])/.test(normalizeModelId(value));
}

export function isGrok46Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGrok46Signal(model.id) || (model.name !== undefined && hasGrok46Signal(model.name));
}

export function hasGrok47Signal(value: string): boolean {
	// Same id shapes as hasGrok46Signal with a 4.7 minor version, including venice's dashed
	// grok-4-7. Keep 4.6 / 4.5 / 4.3 / 4.20 / 3 out.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?7(?:$|[/@._:-])/.test(normalizeModelId(value));
}

export function isGrok47Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGrok47Signal(model.id) || (model.name !== undefined && hasGrok47Signal(model.name));
}

// Claude Mythos shares each Fable release's prompting guide ("Prompting Claude
// Fable 5.1" covers Fable 5.1 and Mythos 5.1; "Prompting Claude Fable 5"
// covers Fable 5 and Mythos 5), so Mythos ids route to the matching Fable preset.
export const CLAUDE_FABLE_51_MARKERS = ["fable-5-1", "fable-5.1", "mythos-5-1", "mythos-5.1"] as const;
export const CLAUDE_FABLE_5_MARKERS = ["fable-5", "mythos-5"] as const;

export function isClaudeFable51Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_FABLE_51_MARKERS.some((marker) => normalized.includes(marker));
}

export function isClaudeFable5Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_FABLE_5_MARKERS.some((marker) => normalized.includes(marker));
}

export const CLAUDE_OPUS_55_MARKERS = ["opus-5-5", "opus-5.5"] as const;

export function isClaudeOpus55Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_OPUS_55_MARKERS.some((marker) => normalized.includes(marker));
}

export function isClaudeOpus5Model(modelId: string): boolean {
	return normalizeModelId(modelId).includes("opus-5");
}

// Sonnet 5 keeps the default dynamic prompt; only the 5.5 release has a tuned core.
export const CLAUDE_SONNET_55_MARKERS = ["sonnet-5-5", "sonnet-5.5"] as const;

export function isClaudeSonnet55Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_SONNET_55_MARKERS.some((marker) => normalized.includes(marker));
}

// Haiku 4.5 and older keep the default dynamic prompt; only the 5.5 release has a tuned core.
export const CLAUDE_HAIKU_55_MARKERS = ["haiku-5-5", "haiku-5.5"] as const;

export function isClaudeHaiku55Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_HAIKU_55_MARKERS.some((marker) => normalized.includes(marker));
}

export type ClaudeOpusVersion = "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" | "claude-opus-4-5";

export function extractClaudeOpusVersion(modelId: string): ClaudeOpusVersion | undefined {
	const normalized = normalizeModelId(modelId);
	if (normalized.includes("opus-4-8")) {
		return "claude-opus-4-8";
	}
	if (normalized.includes("opus-4-7")) {
		return "claude-opus-4-7";
	}
	if (normalized.includes("opus-4-6")) {
		return "claude-opus-4-6";
	}
	if (normalized.includes("opus-4-5") || normalized.includes("opus-4.5")) {
		return "claude-opus-4-5";
	}
	return undefined;
}
