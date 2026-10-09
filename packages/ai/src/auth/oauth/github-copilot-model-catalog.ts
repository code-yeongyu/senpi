import { GITHUB_COPILOT_MODELS } from "../../providers/github-copilot.models.ts";
import { type GitHubCopilotModelLimit, parseGitHubCopilotModelLimit } from "../../providers/github-copilot-limits.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function parseGitHubCopilotModelCatalog(
	raw: unknown,
	allowPolicyFallback: boolean,
): {
	availableModelIds: string[];
	policyModelIds: string[];
	modelLimits: GitHubCopilotModelLimit[];
} {
	const data = asRecord(raw)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid Copilot models response");
	}

	const accountModels = data.flatMap((rawItem) => {
		const item = asRecord(rawItem);
		const id = item?.id;
		if (!item || typeof id !== "string") return [];

		const capabilities = asRecord(item.capabilities);
		const supports = asRecord(capabilities?.supports);
		if (supports?.tool_calls === false) return [];

		return [
			{
				id,
				pickerEnabled: item.model_picker_enabled === true,
				policyState: asRecord(item.policy)?.state,
				limits: parseGitHubCopilotModelLimit(id, capabilities?.limits),
			},
		];
	});
	const pickerModelIds = accountModels
		.filter((model) => model.pickerEnabled && model.policyState !== "disabled")
		.map((model) => model.id);
	const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
	const availableModelIds =
		pickerModelIds.length > 0 || !allowPolicyFallback
			? pickerModelIds
			: accountModels.filter((model) => model.policyState === "enabled").map((model) => model.id);
	const policyModelIds = accountModels
		.filter(
			(model) =>
				model.policyState === "unconfigured" &&
				Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) &&
				(model.pickerEnabled || usePolicyFallback),
		)
		.map((model) => model.id);
	const modelLimits = accountModels
		.map((model) => model.limits)
		.filter((limits): limits is GitHubCopilotModelLimit => limits !== undefined);
	return { availableModelIds, policyModelIds, modelLimits };
}
