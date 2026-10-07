import type { Api, Model } from "@earendil-works/pi-ai";
import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { buildClaudeFable5Prompt } from "./claude-fable-5.ts";
import { buildClaudeFable51Prompt } from "./claude-fable-5-1.ts";
import { buildClaudeOpus45Prompt } from "./claude-opus-4-5.ts";
import { buildClaudeOpus46Prompt } from "./claude-opus-4-6.ts";
import { buildClaudeOpus47Prompt } from "./claude-opus-4-7.ts";
import { buildClaudeOpus48Prompt } from "./claude-opus-4-8.ts";
import { buildClaudeOpus5Prompt } from "./claude-opus-5.ts";
import { buildClaudeOpus55Prompt } from "./claude-opus-5-5.ts";
import { buildClaudeSonnet55Prompt } from "./claude-sonnet-5-5.ts";
import { buildDeepseekV41FlashPrompt } from "./deepseek-v4-1-flash.ts";
import { buildDeepseekV4FlashPrompt } from "./deepseek-v4-flash.ts";
import { buildDeepseekV4Flash0731Prompt } from "./deepseek-v4-flash-0731.ts";
import { buildDeepseekV4ProPrompt } from "./deepseek-v4-pro.ts";
import { buildGlm52Prompt } from "./glm-5-2.ts";
import { buildGlm53Prompt } from "./glm-5-3.ts";
import { buildGpt52Prompt } from "./gpt-5.2.ts";
import { buildGpt53CodexPrompt } from "./gpt-5.3-codex.ts";
import { buildGpt54Prompt } from "./gpt-5.4.ts";
import { buildGpt55Prompt } from "./gpt-5.5.ts";
import { buildGpt56Prompt } from "./gpt-5.6.ts";
import { buildGpt5Prompt } from "./gpt-5.ts";
import { buildGpt6AstraPrompt } from "./gpt-6-astra.ts";
import { buildGrok45Prompt } from "./grok-4.5.ts";
import { buildGrok46Prompt } from "./grok-4.6.ts";
import { buildGrok47Prompt } from "./grok-4.7.ts";
import { buildKimiK26Prompt } from "./kimi-k2-6.ts";
import { buildKimiK27Prompt } from "./kimi-k2-7.ts";
import { buildKimiK28Prompt } from "./kimi-k2-8.ts";
import { buildKimiK3Prompt } from "./kimi-k3.ts";
import { type PromptPresetName, type PromptPresetSettings, parsePromptPreset } from "./settings.ts";

export type { PromptPresetSettings } from "./settings.ts";

type ResolvedPresetName = Exclude<PromptPresetName, "auto">;
type ModelWithPromptPresetMetadata = Pick<Model<Api>, "id" | "provider"> & {
	name?: string;
	promptPreset?: string;
};

export interface ResolvedPromptPreset {
	name: ResolvedPresetName;
	prompt: string;
}

function normalizeModelId(modelId: string): string {
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
function hasGpt6FamilySignal(value: string): boolean {
	return /(?:^|[/@:._-])gpt[._-]?6(?:[._-]\d+|\d)?[._-](?:astra|sol|luna)(?:$|[/@:._-])/.test(normalizeModelId(value));
}

function isGpt6FamilyModel(model: ModelWithPromptPresetMetadata): boolean {
	return hasGpt6FamilySignal(model.id) || (model.name !== undefined && hasGpt6FamilySignal(model.name));
}

type Gpt5Version = "gpt-5.2" | "gpt-5.3-codex" | "gpt-5.4" | "gpt-5.5" | "gpt-5.6";

function extractGpt5Version(modelId: string): Gpt5Version | undefined {
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

function hasKimiK26Signal(value: string): boolean {
	return /(?:^|[/@._-])kimi-k2(?:[._-]|p)6(?:$|[/@._:-])/.test(normalizeModelId(value));
}

function isKimiK26Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK26Signal(model.id) || (model.name !== undefined && hasKimiK26Signal(model.name));
}

// Kimi Code addresses its models by rolling product ids rather than version tags:
// Moonshot upgraded `kimi-for-coding` to K2.8 Preview in place on 2026-09-11 and
// left `kimi-for-coding-highspeed` on K2.7 Code HighSpeed.
// https://www.kimi.com/code/docs/en/kimi-code/models.html (checked 2026-09-18)
const KIMI_CODE_K27_MODEL_ID = "kimi-for-coding-highspeed";
const KIMI_CODE_K28_MODEL_ID = "kimi-for-coding";

function hasKimiK27Signal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return normalized === KIMI_CODE_K27_MODEL_ID || /(?:^|[/@._-])kimi-k2(?:[._-]|p)7(?:$|[/@._:-])/.test(normalized);
}

function isKimiK27Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK27Signal(model.id) || (model.name !== undefined && hasKimiK27Signal(model.name));
}

function hasKimiK28Signal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return normalized === KIMI_CODE_K28_MODEL_ID || /(?:^|[/@._-])kimi-k2(?:[._-]|p)8(?:$|[/@._:-])/.test(normalized);
}

function isKimiK28Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK28Signal(model.id) || (model.name !== undefined && hasKimiK28Signal(model.name));
}

function hasKimiK3Signal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return normalized === "k3" || /(?:^|[/@._-])kimi-k3(?:$|[/@._:-])/.test(normalized);
}

function isKimiK3Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasKimiK3Signal(model.id) || (model.name !== undefined && hasKimiK3Signal(model.name));
}

// Exactly the SWE-2 lanes Devin's Cascade serves; every other swe-2 uid is refused upstream (#2306).
function hasSWE2Signal(value: string): boolean {
	return /(?:^|[/@:._-])swe-2-(?:medium|high|max)(?:$|[/@:._])/.test(normalizeModelId(value));
}

function isSWE2Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasSWE2Signal(model.id) || (model.name !== undefined && hasSWE2Signal(model.name));
}

// DeepSeek V4 id shapes verified against the OpenRouter live API, models.dev,
// and senpi's generated provider catalogs (2026-07-31): deepseek-v4-flash,
// deepseek/deepseek-v4-flash-0731, deepseek-ai/DeepSeek-V4-Pro,
// accounts/fireworks/models/deepseek-v4-flash, aihubmix's alicloud-deepseek-v4-*,
// and trailing tags (:free, -free, :thinking, -nothinking, -cheaper, -lightning, -el).
function hasDeepseekV4Flash0731Signal(value: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash[._-]0731(?:$|[/@:._-])/.test(normalizeModelId(value));
}

function isDeepseekV4Flash0731Model(model: ModelWithPromptPresetMetadata): boolean {
	return (
		hasDeepseekV4Flash0731Signal(model.id) || (model.name !== undefined && hasDeepseekV4Flash0731Signal(model.name))
	);
}

function hasDeepseekV4FlashSignal(value: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash(?:$|[/@:._-])/.test(normalizeModelId(value));
}

function isDeepseekV4FlashModel(model: ModelWithPromptPresetMetadata): boolean {
	return hasDeepseekV4FlashSignal(model.id) || (model.name !== undefined && hasDeepseekV4FlashSignal(model.name));
}

// DeepSeek V4.1 Flash id shapes verified against models.dev and the provider
// catalogs (2026-09-11): deepseek-flash (the official API name, also opencode-go),
// deepseek-v4.1-flash and deepseek/deepseek-v4.1-flash[:thinking] (OpenRouter,
// Vercel, requesty, kilo, ...), deepseek-ai/DeepSeek-V4.1-Flash (Hugging Face,
// DeepInfra), accounts/fireworks/models/deepseek-v4p1-flash, venice's
// deepseek-v4-1-flash, and the display name "DeepSeek V4.1 Flash".
function hasDeepseekV41FlashSignal(value: string): boolean {
	const normalized = normalizeModelId(value);
	return (
		/(?:^|[/@:._-])deepseek[._-]v4(?:[._-]1|p1)[._-]flash(?:$|[/@:._-])/.test(normalized) ||
		/(?:^|[/@:._-])deepseek[._-]flash(?:$|[/@:._-])/.test(normalized)
	);
}

const DEEPSEEK_OFFICIAL_PROVIDER = "deepseek";

// DeepSeek retired V4 Flash on 2026-09-10: on the official API, deepseek-v4-flash
// and deepseek-v4-flash-vision-exp are served by V4.1 Flash. Every other
// provider still hosts the V4 weights under those names.
function isRetiredOfficialDeepseekV4FlashAlias(model: ModelWithPromptPresetMetadata): boolean {
	return model.provider === DEEPSEEK_OFFICIAL_PROVIDER && hasDeepseekV4FlashSignal(model.id);
}

function isDeepseekV41FlashModel(model: ModelWithPromptPresetMetadata): boolean {
	return (
		hasDeepseekV41FlashSignal(model.id) ||
		(model.name !== undefined && hasDeepseekV41FlashSignal(model.name)) ||
		isRetiredOfficialDeepseekV4FlashAlias(model)
	);
}

function hasDeepseekV4ProSignal(value: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]pro(?:$|[/@:._-])/.test(normalizeModelId(value));
}

function isDeepseekV4ProModel(model: ModelWithPromptPresetMetadata): boolean {
	return hasDeepseekV4ProSignal(model.id) || (model.name !== undefined && hasDeepseekV4ProSignal(model.name));
}

function hasGlm52Signal(value: string): boolean {
	return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)2(?:$|[/@._:-])/.test(normalizeModelId(value));
}

function isGlm52Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGlm52Signal(model.id) || (model.name !== undefined && hasGlm52Signal(model.name));
}

function hasGlm53Signal(value: string): boolean {
	return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)3(?:$|[/@._:-])/.test(normalizeModelId(value));
}

function isGlm53Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGlm53Signal(model.id) || (model.name !== undefined && hasGlm53Signal(model.name));
}

function hasGrok45Signal(value: string): boolean {
	// Match any Grok 4.5 id shape: grok-4.5, grok4.5, grok45, grok-4p5, provider:model,
	// path/prefix ids, and trailing tags (:thinking, -latest). Keep 4.3 / 4.20 / 3 out.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?5(?:$|[/@._:-])/.test(normalizeModelId(value));
}

function isGrok45Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGrok45Signal(model.id) || (model.name !== undefined && hasGrok45Signal(model.name));
}

function hasGrok46Signal(value: string): boolean {
	// Same id shapes as hasGrok45Signal with a 4.6 minor version. Keep 4.5 / 4.3 / 4.20 / 3 out.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?6(?:$|[/@._:-])/.test(normalizeModelId(value));
}

function isGrok46Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGrok46Signal(model.id) || (model.name !== undefined && hasGrok46Signal(model.name));
}

function hasGrok47Signal(value: string): boolean {
	// Same id shapes as hasGrok46Signal with a 4.7 minor version, including venice's dashed
	// grok-4-7. Keep 4.6 / 4.5 / 4.3 / 4.20 / 3 out.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?7(?:$|[/@._:-])/.test(normalizeModelId(value));
}

function isGrok47Model(model: ModelWithPromptPresetMetadata): boolean {
	return hasGrok47Signal(model.id) || (model.name !== undefined && hasGrok47Signal(model.name));
}

// Claude Mythos shares each Fable release's prompting guide ("Prompting Claude
// Fable 5.1" covers Fable 5.1 and Mythos 5.1; "Prompting Claude Fable 5"
// covers Fable 5 and Mythos 5), so Mythos ids route to the matching Fable preset.
const CLAUDE_FABLE_51_MARKERS = ["fable-5-1", "fable-5.1", "mythos-5-1", "mythos-5.1"] as const;
const CLAUDE_FABLE_5_MARKERS = ["fable-5", "mythos-5"] as const;

function isClaudeFable51Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_FABLE_51_MARKERS.some((marker) => normalized.includes(marker));
}

function isClaudeFable5Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_FABLE_5_MARKERS.some((marker) => normalized.includes(marker));
}

const CLAUDE_OPUS_55_MARKERS = ["opus-5-5", "opus-5.5"] as const;

function isClaudeOpus55Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_OPUS_55_MARKERS.some((marker) => normalized.includes(marker));
}

function isClaudeOpus5Model(modelId: string): boolean {
	return normalizeModelId(modelId).includes("opus-5");
}

// Sonnet 5 keeps the default dynamic prompt; only the 5.5 release has a tuned core.
const CLAUDE_SONNET_55_MARKERS = ["sonnet-5-5", "sonnet-5.5"] as const;

function isClaudeSonnet55Model(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return CLAUDE_SONNET_55_MARKERS.some((marker) => normalized.includes(marker));
}

type ClaudeOpusVersion = "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" | "claude-opus-4-5";

function extractClaudeOpusVersion(modelId: string): ClaudeOpusVersion | undefined {
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

export function resolvePresetName(
	model: ModelWithPromptPresetMetadata,
	settings: PromptPresetSettings,
): ResolvedPresetName | undefined {
	if (settings.promptPreset !== "auto") {
		return settings.promptPreset;
	}

	const modelPromptPreset = parsePromptPreset(model.promptPreset);
	if (modelPromptPreset && modelPromptPreset !== "auto") {
		return modelPromptPreset;
	}

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

function buildPreset(name: ResolvedPresetName, options: BuildDynamicSystemPromptOptions): ResolvedPromptPreset {
	switch (name) {
		case "gpt-6-astra":
			return { name, prompt: buildGpt6AstraPrompt(options) };
		case "gpt-5.6":
			return { name, prompt: buildGpt56Prompt(options) };
		case "gpt-5.5":
			return { name, prompt: buildGpt55Prompt(options) };
		case "gpt-5.4":
			return { name, prompt: buildGpt54Prompt(options) };
		case "gpt-5.3-codex":
			return { name, prompt: buildGpt53CodexPrompt(options) };
		case "gpt-5.2":
			return { name, prompt: buildGpt52Prompt(options) };
		case "gpt-5":
			return { name, prompt: buildGpt5Prompt(options) };
		case "glm-5.3":
			return { name, prompt: buildGlm53Prompt(options) };
		case "glm-5.2":
			return { name, prompt: buildGlm52Prompt(options) };
		case "deepseek-v4-flash":
			return { name, prompt: buildDeepseekV4FlashPrompt(options) };
		case "deepseek-v4-flash-0731":
			return { name, prompt: buildDeepseekV4Flash0731Prompt(options) };
		case "deepseek-v4-1-flash":
			return { name, prompt: buildDeepseekV41FlashPrompt(options) };
		case "deepseek-v4-pro":
			return { name, prompt: buildDeepseekV4ProPrompt(options) };
		case "grok-4.7":
			return { name, prompt: buildGrok47Prompt(options) };
		case "grok-4.6":
			return { name, prompt: buildGrok46Prompt(options) };
		case "grok-4.5":
			return { name, prompt: buildGrok45Prompt(options) };
		case "kimi-k3":
			return { name, prompt: buildKimiK3Prompt(options) };
		case "kimi-k2-8":
			return { name, prompt: buildKimiK28Prompt(options) };
		case "kimi-k2-7":
			return { name, prompt: buildKimiK27Prompt(options) };
		case "kimi-k2-6":
			return { name, prompt: buildKimiK26Prompt(options) };
		case "claude-fable-5-1":
			return { name, prompt: buildClaudeFable51Prompt(options) };
		case "claude-fable-5":
			return { name, prompt: buildClaudeFable5Prompt(options) };
		case "claude-opus-5-5":
			return { name, prompt: buildClaudeOpus55Prompt(options) };
		case "claude-sonnet-5-5":
			return { name, prompt: buildClaudeSonnet55Prompt(options) };
		case "claude-opus-5":
			return { name, prompt: buildClaudeOpus5Prompt(options) };
		case "claude-opus-4-8":
			return { name, prompt: buildClaudeOpus48Prompt(options) };
		case "claude-opus-4-7":
			return { name, prompt: buildClaudeOpus47Prompt(options) };
		case "claude-opus-4-6":
			return { name, prompt: buildClaudeOpus46Prompt(options) };
		case "claude-opus-4-5":
			return { name, prompt: buildClaudeOpus45Prompt(options) };
	}
}

function withDefaults(options: Partial<BuildDynamicSystemPromptOptions> = {}): BuildDynamicSystemPromptOptions {
	return {
		cwd: options.cwd ?? "",
		selectedTools: options.selectedTools ?? [],
		toolSnippets: options.toolSnippets ?? {},
		promptGuidelines: options.promptGuidelines ?? [],
		contextFiles: options.contextFiles ?? [],
		skills: options.skills ?? [],
		surface: options.surface ?? "terminal",
	};
}

export function resolvePreset(
	model: ModelWithPromptPresetMetadata,
	settings: PromptPresetSettings,
	options?: Partial<BuildDynamicSystemPromptOptions>,
): ResolvedPromptPreset | undefined {
	const name = resolvePresetName(model, settings);
	if (!name) {
		return undefined;
	}
	return buildPreset(name, withDefaults(options));
}
