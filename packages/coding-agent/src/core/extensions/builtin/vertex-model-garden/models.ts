import type { ProviderChatModelConfig, ProviderModelConfig } from "../../types.ts";

// This starter list covers open models through the global OpenAI-compatible endpoint.
// Marketplace partner models are excluded: they are card-billed and promotional credits do not apply.
// Prices are the model card's published MaaS list prices, USD per million tokens
// (https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing,
// "Deepseek's models" and "GLM's models"); DeepSeek V4.1 Flash is listed at no charge through 2026-10-16.
//
// Thinking on this endpoint is a single on/off switch, not an effort ladder: the request-level
// control is a chat-template flag whose name differs per model. Live probes against the global
// OpenAPI endpoint (2026-11-09) showed GLM 5.2 toggles via `enable_thinking` while DeepSeek V4.1
// Flash toggles via `thinking`, and a wrong flag name is silently ignored rather than rejected —
// so each model must send exactly its own flag. `medium` is the canonical "on" level.
const THINKING_LEVELS = {
	off: "off",
	minimal: null,
	low: null,
	medium: "on",
	high: null,
	xhigh: null,
	max: null,
} as const;

/** One on/off chat-template flag; a selected non-off level sends `true`, off sends `false`. */
function thinkingToggle(flag: string): NonNullable<ProviderChatModelConfig["compat"]> {
	return {
		thinkingFormat: "chat-template",
		supportsReasoningEffort: false,
		supportsDeveloperRole: false,
		chatTemplateKwargs: { [flag]: { $var: "thinking.enabled" as const } },
	};
}

function garden(
	id: string,
	name: string,
	cost: ProviderModelConfig["cost"],
	contextWindow: number,
	compat: ProviderChatModelConfig["compat"],
	defaultThinkingLevel: "off" | "medium",
): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: THINKING_LEVELS,
		input: ["text"],
		cost,
		contextWindow,
		maxTokens: 32_000,
		compat,
		defaultThinkingLevel,
	};
}

export const VERTEX_MODEL_GARDEN_MODELS: ProviderModelConfig[] = [
	garden(
		"deepseek-ai/deepseek-v4.1-flash-maas",
		"DeepSeek V4.1 Flash (Vertex)",
		{ input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
		1_000_000,
		thinkingToggle("thinking"),
		// DeepSeek V4.1 Flash does not think by default on Vertex (verified 2026-11-09).
		"off",
	),
	garden(
		"zai-org/glm-5.2-maas",
		"GLM 5.2 (Vertex)",
		{ input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
		200_000,
		thinkingToggle("enable_thinking"),
		// GLM 5.2 thinks by default on Vertex (verified 2026-11-09).
		"medium",
	),
];
