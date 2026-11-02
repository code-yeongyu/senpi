import { USAGE_LIMIT_EXHAUSTION } from "@earendil-works/pi-ai/utils/retry";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An account-scoped usage limit that reaches the pool as text alone (senpi#1768).
// Every alternative is a shape a supported provider is known to send:
//   - OpenAI / Codex hard quota: `usage_limit_reached`, `usage_not_included`,
//     "The usage limit has been reached" (shared USAGE_LIMIT_EXHAUSTION markers)
//   - "You have hit your ChatGPT usage limit", "You've hit your session limit",
//     "You've reached your 5-hour limit" / "You've reached your usage limit"
//   - OpenCode "Monthly usage limit reached", `GoUsageLimitError`, `FreeUsageLimitError`
//   - Claude Code terminal reasons `blocking_limit`, `rapid_refill_breaker`
//   - "quota exceeded" (GitHub Copilot, gateway wording)
// It stays anchored on exhaustion verbs: "You are approaching your usage limit"
// is a warning, and the overflow prose in `utils/overflow.ts` (token limit,
// context limit) is excluded by the caller, because this runs before the
// overflow branch and must never block a healthy account for a large request.
const ACCOUNT_USAGE_LIMIT_TEXT = new RegExp(
	[
		...USAGE_LIMIT_EXHAUSTION.markers.map(escapeRegExp),
		String.raw`\b(?:hit|reached)\s+your\b[^.]*?\blimit\b`,
		String.raw`\busage\s+limit\s+reached\b`,
		String.raw`\b(?:Go|Free)UsageLimitError\b`,
		String.raw`\bblocking_limit\b`,
		String.raw`\brapid_refill_breaker\b`,
		String.raw`\bquota\s+exceeded\b`,
	].join("|"),
	"i",
);

export function isAccountUsageLimitText(text: string): boolean {
	return ACCOUNT_USAGE_LIMIT_TEXT.test(text);
}
