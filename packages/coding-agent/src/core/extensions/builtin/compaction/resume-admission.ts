import type { ModelUsabilityBudgetProjection } from "./model-usability-budget.ts";

export interface ResumeCompactionRequirement {
	readonly projection: ModelUsabilityBudgetProjection;
	readonly notice: string;
}

export function createResumeCompactionRequirement(
	projection: ModelUsabilityBudgetProjection,
): ResumeCompactionRequirement {
	return {
		projection,
		notice: `Context exceeds the model budget by ${projection.shortfallTokens} tokens; compacting before the first prompt.`,
	};
}
