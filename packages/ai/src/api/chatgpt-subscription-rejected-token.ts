// ChatGPT invalidates a subscription access token server-side ("Your authentication token has
// expired. Please try refreshing it.", HTTP 401) while its stored expiry still says it is valid;
// the Codex CLI refreshes and retries on that 401 (#3407). 403 stays out: on this backend it
// means the account or region is refused, which a refresh cannot fix.
export const CHATGPT_SUBSCRIPTION_REJECTED_TOKEN_STATUSES: readonly number[] = [401];

/**
 * Only a 401 whose body names the token as expired or invalid is a refused token. Other 401s
 * (account, workspace, plan, region) are not fixed by a refresh: refreshing would burn a
 * refresh-token rotation and, on the retry's second 401, block the pooled slot until a new
 * login, so they surface as they are.
 */
export const CHATGPT_SUBSCRIPTION_REJECTED_TOKEN_MESSAGE =
	/\btoken_expired\b|\binvalid_token\b|\btoken\b[^.\n]{0,40}?\b(?:expired|invalid|revoked)\b|\binvalid (?:access |auth(?:entication)? )?token\b/i;
