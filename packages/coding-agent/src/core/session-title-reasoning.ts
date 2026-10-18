import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

const REASONING_MANDATORY_ERROR = /reasoning is mandatory/i;

/**
 * Reasoning level for the first title request. Titles stay reasoning-free unless the catalog
 * says the model cannot turn reasoning off; then the lowest supported level is requested, because
 * an unset level maps to the provider's "disabled" value, which those endpoints reject with 400.
 */
export function initialTitleReasoning(model: Model<Api>): ThinkingLevel | undefined {
	if (!model.reasoning) return undefined;
	const levels = getSupportedThinkingLevels(model);
	if (levels.includes("off")) return undefined;
	return asReasoningLevel(levels[0]);
}

/**
 * Reasoning level for one retry after a reasoning-free title request was rejected because the
 * endpoint mandates reasoning, which means its catalog entry is stale. `low` is the effort every
 * such endpoint seen so far accepts, clamped to what the catalog still allows.
 */
export function mandatoryReasoningRetryLevel(
	model: Model<Api>,
	sentReasoning: ThinkingLevel | undefined,
	errorMessage: string | undefined,
): ThinkingLevel | undefined {
	if (sentReasoning !== undefined || errorMessage === undefined) return undefined;
	if (!REASONING_MANDATORY_ERROR.test(errorMessage)) return undefined;
	return asReasoningLevel(clampThinkingLevel(model, "low"));
}

function asReasoningLevel(level: ModelThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === undefined || level === "off" ? undefined : level;
}
