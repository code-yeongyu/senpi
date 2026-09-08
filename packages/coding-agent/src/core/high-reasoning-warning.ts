import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

// Matches GPT-5.x Sol and GPT-6 Astra variants, including provider-prefixed
// forms. The trailing lookahead excludes unrelated ids that continue with letters.
const SENSITIVE_MODEL_ID_PATTERN = /(?:gpt-5(?:\.\d+)?-sol|gpt-6-astra)(?![a-z])/i;

export function isSensitiveHighReasoningModel(model: Pick<Model<Api>, "id">): boolean {
	return SENSITIVE_MODEL_ID_PATTERN.test(model.id);
}

export function shouldWarnHighReasoning(model: Pick<Model<Api>, "id">, thinkingLevel: ThinkingLevel): boolean {
	return (thinkingLevel === "xhigh" || thinkingLevel === "max") && isSensitiveHighReasoningModel(model);
}

export interface HighReasoningWarningContent {
	readonly title: string;
	readonly body: readonly string[];
}

export function buildHighReasoningWarning(
	model: Pick<Model<Api>, "id" | "provider">,
	thinkingLevel: ThinkingLevel,
): HighReasoningWarningContent {
	const modelId = model.id;
	const title = `⚠ HIGH-REASONING MODEL WARNING — ${model.provider}/${modelId} @ ${thinkingLevel}`;
	const body = [
		`${modelId} is a frontier reasoning model. Running it at "${thinkingLevel}" effort makes it acutely sensitive to prompt quality.`,
		"Driving this model directly from a human prompt is NOT recommended. Risks include:",
		"  • The model may refuse to stop, looping or working far past the stated goal.",
		'  • It may perform unrequested actions in order to "complete" the task.',
		"  • It may take risky, irreversible, or dangerous actions to force completion.",
		"Strongly recommended: use this model ONLY through the ultrabrain subagent.",
		"Human prompts leave gaps; an agent-authored prompt is denser and stricter than a human's — exactly what these high-effort models need to stay bounded.",
		'From the main agent, delegate instead: "query ultrabrain with <task>".',
		`If you drive this model directly at ${thinkingLevel}, YOU assume ALL responsibility for the consequences.`,
	];
	return { title, body };
}
