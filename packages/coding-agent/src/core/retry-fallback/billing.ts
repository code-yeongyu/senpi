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

/**
 * Billing markers that prove a spent account on their own. The bare `\bbilling\b`
 * word is deliberately excluded: senpi#4632 shows a gateway 503 whose body
 * merely mentions a billing lookup ("resolve Billing Scope: ... dial tcp: i/o
 * timeout") — a dependency failure, not a spent account.
 */
const STRONG_BILLING_ERROR_PATTERN = new RegExp(
	[
		"credit[- ]balance",
		"insufficient[_ -]quota",
		"purchase credits",
		"credits[-_ ]required",
		"credits are required",
		"usage_limit_reached",
		"usage_not_included",
		"usage limit has been reached",
	].join("|"),
	"i",
);

/**
 * Transient server-side evidence that gates bare billing prose (senpi#4632):
 * a 5xx status token in the message, or the OpenAI-envelope `server_error`
 * type. An explicit quota code above keeps its billing verdict whatever status
 * wraps it.
 */
const TRANSIENT_SERVER_SIGNAL_PATTERN =
	/(?:^|[^0-9])(?:500|502|503|504|520|522|524)(?:[^0-9]|$)|"type"\s*:\s*"server_error"/i;

export function isBillingErrorMessage(errorMessage: string | undefined): boolean {
	if (errorMessage === undefined) return false;
	if (STRONG_BILLING_ERROR_PATTERN.test(errorMessage)) return true;
	if (!BILLING_ERROR_PATTERN.test(errorMessage)) return false;
	// senpi#4632: bare "Billing" prose on a transient 5xx is a gateway
	// dependency failure, not a spent account — it must not pin the fallback
	// or hold the whole provider as an account limit.
	return !TRANSIENT_SERVER_SIGNAL_PATTERN.test(errorMessage);
}
