import type { ProviderModelConfig } from "../../types.ts";

// This starter list covers open models through the global OpenAI-compatible endpoint.
// Marketplace partner models are excluded: they are card-billed and promotional credits do not apply.
// Prices are the model card's published MaaS list prices, USD per million tokens
// (https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing,
// "Deepseek's models" and "GLM's models"); DeepSeek V4.1 Flash is listed at no charge through 2026-10-16.
// These endpoints accept no thinking parameters, so no level may be offered as steerable.
const NO_THINKING_CONTROLS = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: null,
};
const OPENAPI_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false };

function garden(
	id: string,
	name: string,
	cost: ProviderModelConfig["cost"],
	contextWindow: number,
): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: NO_THINKING_CONTROLS,
		input: ["text"],
		cost,
		contextWindow,
		maxTokens: 32_000,
		compat: OPENAPI_COMPAT,
	};
}

export const VERTEX_MODEL_GARDEN_MODELS: ProviderModelConfig[] = [
	garden(
		"deepseek-ai/deepseek-v4.1-flash-maas",
		"DeepSeek V4.1 Flash (Vertex)",
		{ input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
		1_000_000,
	),
	garden(
		"zai-org/glm-5.2-maas",
		"GLM 5.2 (Vertex)",
		{ input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
		200_000,
	),
];
