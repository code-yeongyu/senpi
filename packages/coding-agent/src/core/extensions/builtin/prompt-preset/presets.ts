import type { Api, Model } from "@mariozechner/pi-ai";
import { buildHephaestusBasePrompt } from "./hephaestus-base.js";
import type { PromptPresetName, PromptPresetSettings } from "./settings.js";
import { buildSisyphusBasePrompt } from "./sisyphus-base.js";

export type { PromptPresetSettings } from "./settings.js";

export interface ResolvedPromptPreset {
	name: Exclude<PromptPresetName, "auto">;
	prompt: string;
}

function normalizeModelId(modelId: string): string {
	return modelId.toLowerCase();
}

function isHephaestusModel(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return normalized.includes("gpt-5.4") || normalized.includes("gpt-5.5");
}

function isSisyphusModel(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	return normalized.includes("kimi-k2.6") || normalized.includes("opus-4-7") || normalized.includes("opus-4-6");
}

function buildPreset(
	name: Exclude<PromptPresetName, "auto">,
	buildSenpiToolSection: () => string,
): ResolvedPromptPreset {
	if (name === "hephaestus") {
		return { name, prompt: buildHephaestusBasePrompt(buildSenpiToolSection) };
	}
	return { name, prompt: buildSisyphusBasePrompt(buildSenpiToolSection) };
}

export function resolvePreset(
	model: Pick<Model<Api>, "id" | "provider">,
	settings: PromptPresetSettings,
	buildSenpiToolSection: () => string = () => "",
): ResolvedPromptPreset | undefined {
	if (settings.promptPreset === "sisyphus" || settings.promptPreset === "hephaestus") {
		return buildPreset(settings.promptPreset, buildSenpiToolSection);
	}

	if (isHephaestusModel(model.id)) {
		return buildPreset("hephaestus", buildSenpiToolSection);
	}

	if (isSisyphusModel(model.id)) {
		return buildPreset("sisyphus", buildSenpiToolSection);
	}

	return undefined;
}
