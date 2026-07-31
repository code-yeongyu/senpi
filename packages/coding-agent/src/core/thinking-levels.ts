import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

const THINKING_LEVELS_WITH_MAX: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function supportsXhigh(model: Model<Api>): boolean {
	const mappedLevel = model.thinkingLevelMap?.xhigh;
	if (mappedLevel === null) return false;
	if (mappedLevel !== undefined) return true;
	if (model.thinkingLevelMap !== undefined) return false;

	return (
		model.id.includes("gpt-5.2") ||
		model.id.includes("gpt-5.3") ||
		model.id.includes("gpt-5.4") ||
		model.id.includes("gpt-5.5") ||
		model.id.includes("gpt-5.6") ||
		model.id.includes("deepseek-v4-pro") ||
		model.id.includes("deepseek-v4-flash") ||
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("fable-5")
	);
}

export function supportsMax(model: Model<Api>): boolean {
	const mappedLevel = model.thinkingLevelMap?.max;
	if (mappedLevel === null) return false;
	if (mappedLevel !== undefined) return true;
	if (model.thinkingLevelMap !== undefined) return false;

	const openAiMaxApis: Api[] = [
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"openai-completions",
	];
	return (
		(openAiMaxApis.includes(model.api) && /(?:^|\/)gpt-5\.6-sol(?:$|-)/.test(model.id)) ||
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("fable-5")
	);
}

export function getSupportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	const supportedLevels = THINKING_LEVELS_WITH_MAX.filter((level) => {
		const mappedLevel = model.thinkingLevelMap?.[level];
		if (mappedLevel === null) return false;
		if (level === "xhigh") return mappedLevel !== undefined || supportsXhigh(model);
		if (level === "max") return mappedLevel !== undefined || supportsMax(model);
		return true;
	});

	return supportedLevels.length > 0 ? supportedLevels : ["off"];
}
