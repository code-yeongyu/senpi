export const EVAL_SUMMARY_MAX_LENGTH = 80;

const ELLIPSIS = "...";

export function clampEvalSummary(value) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/\s+/gu, " ");
	if (normalized.length === 0) return undefined;
	if (normalized.length <= EVAL_SUMMARY_MAX_LENGTH) return normalized;
	return `${normalized.slice(0, EVAL_SUMMARY_MAX_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}
