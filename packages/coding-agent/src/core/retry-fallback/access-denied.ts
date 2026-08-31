/**
 * Access-denied provider failures (HTTP 403, unacknowledged data policy gates,
 * plan/entitlement refusals). Retrying the same account never recovers these
 * until the user changes something out of band, so the model is marked
 * unavailable and hidden from selectors until the mark expires.
 *
 * Patterns stay deliberately conservative: a false positive hides a working
 * model, a false negative only keeps a broken model visible.
 */
const ACCESS_DENIED_PATTERN =
	/\b403\b|forbidden|access denied|actionrequired|data (?:retention|usage) policy|policy (?:not|has not been) (?:accepted|acknowledged)|not entitled|insufficient permissions|model (?:is )?not available (?:for|on|with) (?:your|this) (?:plan|account|subscription)/i;

export function isAccessDeniedErrorMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && ACCESS_DENIED_PATTERN.test(errorMessage);
}
