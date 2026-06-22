import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model, ModelThinkingLevel, OpenAICompletionsCompat, Usage } from "./types.ts";

type GeneratedProvider = keyof typeof MODELS;

const providerNames = Object.keys(MODELS) as KnownProvider[];
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

function normalizeGeneratedModel(model: Model<Api>): Model<Api> {
	if (
		model.api !== "openai-completions" ||
		(model.provider !== "xiaomi" && !model.provider.startsWith("xiaomi-token-plan-"))
	) {
		return model;
	}

	const compat: OpenAICompletionsCompat = {
		...(model.compat as OpenAICompletionsCompat | undefined),
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
		supportsDisabledThinking: false,
	};
	return { ...model, compat };
}

function getProviderModels(provider: GeneratedProvider): Map<string, Model<Api>> | undefined {
	const cached = modelRegistry.get(provider);
	if (cached) return cached;
	const models = MODELS[provider];
	if (!models) return undefined;
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, normalizeGeneratedModel(model as Model<Api>));
	}
	modelRegistry.set(provider, providerModels);
	return providerModels;
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = getProviderModels(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return providerNames.slice();
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = getProviderModels(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite * shortWrite + model.cost.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 / GPT-5.4 / GPT-5.5 model families (native xhigh, no native max)
 * - DeepSeek V4 Pro and Flash
 * - Opus 4.6 models (xhigh maps to adaptive effort "max" on Anthropic-compatible providers)
 * - Opus 4.7 / 4.8 models (native xhigh and max both available)
 */
export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
	if (
		model.id.includes("gpt-5.2") ||
		model.id.includes("gpt-5.3") ||
		model.id.includes("gpt-5.4") ||
		model.id.includes("gpt-5.5") ||
		model.id.includes("deepseek-v4-pro") ||
		model.id.includes("deepseek-v4-flash") ||
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8")
	) {
		return true;
	}

	return false;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined || supportsXhigh(model);
		if (level === "max") return mapped !== undefined || supportsMax(model);
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if a model exposes the native "max" thinking tier.
 *
 * Today this is Anthropic-only: Opus 4.6 (legacy max) and Opus 4.7/4.8
 * (native max). OpenAI xhigh-capable models (GPT-5.2/5.3/5.4) do not
 * have a native max tier; callers that want to expose "max" to users
 * should gate UI/session state on this check rather than supportsXhigh.
 */
export function supportsMax<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
		return true;
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8")
	) {
		return true;
	}
	return false;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
