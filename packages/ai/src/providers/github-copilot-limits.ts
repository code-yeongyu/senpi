import type { Credential } from "../auth/types.ts";
import type { Api, Model } from "../types.ts";

export interface GitHubCopilotModelLimit {
	readonly id: string;
	readonly maxContextWindowTokens?: number;
	readonly maxPromptTokens?: number;
	readonly maxOutputTokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function parseGitHubCopilotModelLimit(id: string, rawLimits: unknown): GitHubCopilotModelLimit | undefined {
	const limits = asRecord(rawLimits);
	if (!limits) return undefined;
	const maxContextWindowTokens = positiveInteger(limits.max_context_window_tokens);
	const maxPromptTokens = positiveInteger(limits.max_prompt_tokens);
	const maxOutputTokens = positiveInteger(limits.max_output_tokens);
	if (maxContextWindowTokens === undefined && maxPromptTokens === undefined && maxOutputTokens === undefined) {
		return undefined;
	}
	return {
		id,
		...(maxContextWindowTokens !== undefined ? { maxContextWindowTokens } : {}),
		...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
}

function storedModelLimit(value: unknown): GitHubCopilotModelLimit | undefined {
	const entry = asRecord(value);
	if (!entry || typeof entry.id !== "string") return undefined;
	const maxContextWindowTokens = positiveInteger(entry.maxContextWindowTokens);
	const maxPromptTokens = positiveInteger(entry.maxPromptTokens);
	const maxOutputTokens = positiveInteger(entry.maxOutputTokens);
	if (maxContextWindowTokens === undefined && maxPromptTokens === undefined && maxOutputTokens === undefined) {
		return undefined;
	}
	return {
		id: entry.id,
		...(maxContextWindowTokens !== undefined ? { maxContextWindowTokens } : {}),
		...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
}

export function applyGitHubCopilotModelLimits<TApi extends Api>(
	models: readonly Model<TApi>[],
	credential: Credential | undefined,
): readonly Model<TApi>[] {
	if (credential?.type !== "oauth" || !Array.isArray(credential.copilotModelLimits)) return models;
	const limitsById = new Map(
		credential.copilotModelLimits
			.map(storedModelLimit)
			.filter((entry): entry is GitHubCopilotModelLimit => entry !== undefined)
			.map((entry) => [entry.id, entry] as const),
	);
	if (limitsById.size === 0) return models;
	return models.map((model) => {
		const limits = limitsById.get(model.id);
		if (!limits) return model;
		const reportedPromptLimit = limits.maxPromptTokens ?? limits.maxContextWindowTokens;
		const contextWindow =
			reportedPromptLimit !== undefined && limits.maxContextWindowTokens !== undefined
				? Math.min(reportedPromptLimit, limits.maxContextWindowTokens)
				: reportedPromptLimit;
		return {
			...model,
			contextWindow: contextWindow ?? model.contextWindow,
			maxTokens: limits.maxOutputTokens ?? model.maxTokens,
		};
	});
}
