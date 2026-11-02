/** GPT-specific bridge to eval's model-aware Tool Guidelines. */
export function buildGptEvalRoutingTuning(): string {
	return "When `eval` is available, its Tool Guidelines are binding for multi-call work: the independent reads, searches, symbol lookups, and probes a step already knows it needs go into one cell together, and a turn spent on a single read or search while the others are already known is a defect.";
}
