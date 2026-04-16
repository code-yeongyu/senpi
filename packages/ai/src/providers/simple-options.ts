import type { Api, Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.js";

/**
 * Merge user-supplied extraBody fields into a provider request payload, skipping
 * any key the provider manages itself (model id, messages, stream flag, etc.).
 * Mutates `target` in place for zero-copy integration into per-provider builders.
 */
export function applyExtraBody(
	target: Record<string, unknown>,
	extraBody: Record<string, unknown> | undefined,
	reservedKeys: ReadonlySet<string>,
): void {
	if (!extraBody) return;
	for (const [key, value] of Object.entries(extraBody)) {
		if (reservedKeys.has(key)) continue;
		target[key] = value;
	}
}

export const OPENAI_COMPLETIONS_RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"stream",
	"stream_options",
	"tools",
	"tool_choice",
	"max_tokens",
	"max_completion_tokens",
	"reasoning_effort",
	"reasoning",
	"thinking",
	"enable_thinking",
	"chat_template_kwargs",
	"provider",
]);

export const OPENAI_RESPONSES_RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
	"model",
	"input",
	"instructions",
	"stream",
	"tools",
	"tool_choice",
	"reasoning",
	"max_output_tokens",
	"text",
	"store",
	"include",
]);

export const GOOGLE_RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
	"model",
	"contents",
	"systemInstruction",
	"tools",
	"toolConfig",
	"config",
	"generationConfig",
	"cachedContent",
]);

export const MISTRAL_RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"stream",
	"tools",
	"toolChoice",
	"maxTokens",
]);

export const BEDROCK_RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
	"modelId",
	"messages",
	"system",
	"toolConfig",
	"additionalModelRequestFields",
	"inferenceConfig",
]);

export function buildBaseOptions(model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		extraBody: options?.extraBody,
		onPayload: options?.onPayload,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined {
	return effort === "xhigh" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
	baseMaxTokens: number,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
