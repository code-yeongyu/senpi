export const CLAUDE_POOL_BLOCKED_HEADING = "All Claude accounts for anthropic-subscription are currently blocked (";
export const CLAUDE_POOL_MODEL_LIMIT_LEAD = "All Anthropic Subscription accounts have hit the usage limit for model ";

/** Only read the fixed prelude and the trailing retry marker of a Claude pool refusal. */
export function fallbackClassificationText(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const firstBreak = text.indexOf("\n");
	if (firstBreak === -1) return text;
	const headingStart = text.startsWith(CLAUDE_POOL_MODEL_LIMIT_LEAD) ? firstBreak + 1 : 0;
	if (!text.startsWith(CLAUDE_POOL_BLOCKED_HEADING, headingStart)) return text;
	const headingEnd = text.indexOf("\n", headingStart);
	if (headingEnd === -1) return text;
	// Account labels can contain arbitrary text, including line breaks. Do not scan the account list
	// for a delimiter or a retry hint: the renderer always puts its own marker after the footer.
	const retryAfter = / \(retry-after-ms: \d+\)$/.exec(text)?.[0] ?? "";
	return text.slice(0, headingEnd) + retryAfter;
}
