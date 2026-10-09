/**
 * Billing-class provider failures (credit exhaustion, hard account quota).
 * These never recover by retrying the same account, so the fallback switch for
 * one is always pinned: the candidate becomes the session model for the rest of
 * the session instead of reverting after the billing cooldown.
 *
 * The OpenAI hard-quota exhaustion family (`usage_limit_reached`,
 * `usage_not_included`, "usage limit has been reached") is inlined here to keep
 * this module import-free; its single source of truth is
 * `USAGE_LIMIT_EXHAUSTION` in `@earendil-works/pi-ai`'s `utils/retry.ts`
 * (senpi#1969).
 */
const BILLING_ERROR_PATTERN = new RegExp(
	[
		"credit[- ]balance",
		"insufficient[_ -]quota",
		"\\bbilling\\b",
		"purchase credits",
		"credits[-_ ]required",
		"credits are required",
		// OpenAI hard-quota exhaustion (senpi#1969). Inlined to keep this module
		// import-free; the single source of truth is USAGE_LIMIT_EXHAUSTION in
		// @earendil-works/pi-ai utils/retry.ts.
		"usage_limit_reached",
		"usage_not_included",
		"usage limit has been reached",
	].join("|"),
	"i",
);

export function isBillingErrorMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && BILLING_ERROR_PATTERN.test(errorMessage);
}
