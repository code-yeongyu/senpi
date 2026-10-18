/** GPT-specific bridge to eval's model-aware Tool Guidelines. */
export function buildGptEvalRoutingTuning(): string {
	return "When `eval` is available, follow its Tool Guidelines for multi-call work.";
}
