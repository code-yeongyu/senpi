/** GPT-specific bridge to eval's model-aware Tool Guidelines. */
export function buildGptEvalRoutingTuning(): string {
	return (
		"When `exec` and `wait` are available, use `exec` for bounded JavaScript orchestration of tool calls " +
		"and `wait` for yielded cells; otherwise, when `eval` is available, follow its Tool Guidelines for multi-call work."
	);
}
