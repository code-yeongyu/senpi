import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { buildClaudeFable5Prompt } from "./claude-fable-5.ts";
import { buildClaudeFable51Prompt } from "./claude-fable-5-1.ts";
import { buildClaudeHaiku55Prompt } from "./claude-haiku-5-5.ts";
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
import { type PromptPresetName, type PromptPresetSettings, parsePromptPreset } from "./settings.ts";

export type { PromptPresetSettings } from "./settings.ts";

type ResolvedPresetName = Exclude<PromptPresetName, "auto">;

export interface ResolvedPromptPreset {
	name: ResolvedPresetName;
	prompt: string;
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
		case "claude-haiku-5-5":
			return { name, prompt: buildClaudeHaiku55Prompt(options) };
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
