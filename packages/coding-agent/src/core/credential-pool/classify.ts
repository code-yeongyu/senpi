import { DEFAULT_SLOT_BLOCK_MS, MAX_SLOT_BLOCK_MS } from "@earendil-works/pi-ai/auth/pool/failover";
import { normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { getOverflowPatterns } from "@earendil-works/pi-ai/utils/overflow";
import { extract429RetryAfterMs } from "@earendil-works/pi-ai/utils/retry-hint";

export const COOLDOWN_BASE_MS = DEFAULT_SLOT_BLOCK_MS;
export const COOLDOWN_CAP_MS = MAX_SLOT_BLOCK_MS;
export const RETRY_SAME_MAX_ATTEMPTS = 2;

export type CredentialBlock =
	| { reason: "auth_error" }
	| { reason: "account_disabled" }
	| { reason: "rate_limit"; cooldownMs: number; retryAfterWasCapped: boolean };

export type CredentialAction =
	| { kind: "failover"; block: CredentialBlock }
	| { kind: "retry_same"; maxAttempts: typeof RETRY_SAME_MAX_ATTEMPTS }
	| { kind: "fail_request" };

/**
 * Per-slot exponential cooldown with the server hint as a FLOOR, never an
 * override: a hint can only lengthen the wait the failure count already earned,
 * and everything caps at 48 hours with the capping recorded.
 */
export function rateLimitCooldown(
	failureCount: number,
	serverHintMs?: number,
): { cooldownMs: number; retryAfterWasCapped: boolean } {
	const backoff = Math.min(COOLDOWN_CAP_MS, COOLDOWN_BASE_MS * 2 ** Math.max(0, failureCount));
	const floored = serverHintMs === undefined ? backoff : Math.max(backoff, serverHintMs);
	return { cooldownMs: Math.min(COOLDOWN_CAP_MS, floored), retryAfterWasCapped: floored > COOLDOWN_CAP_MS };
}

const INVALID_KEY_TEXT = /invalid[ _-]?(?:api[ _-]?)?key|authentication[_ ]?error|invalid x-api-key|unauthorized/i;
const ACCOUNT_SCOPED_403_TEXT = /account|credential|token|api[ _-]?key|organization|subscription/i;
const RATE_LIMIT_TEXT = /rate[ _-]?limit|too many requests|resource_exhausted/i;
const BILLING_TEXT =
	/billing|credits?[ _-]?(?:required|exhausted|balance)|insufficient[ _-]?(?:funds|quota|credit)|payment[ _-]?required|quota[ _-]?exhausted/i;
const OVERLOAD_TEXT = /overloaded/i;
const NETWORK_TEXT =
	/econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|request timed out/i;
const FAIL_FAST_TEXT =
	/context[ _-]?(?:length|window)|maximum context|invalid[ _-]?model|model[ _-]?not[ _-]?found|malformed[ _-]?stream|premature[ _-]?(?:close|stream)/i;
const ABORT_TEXT = /\baborted?\b/i;

function isAbort(error: unknown, message: string): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	return ABORT_TEXT.test(message);
}

function isOverflowText(text: string): boolean {
	return getOverflowPatterns().some((pattern) => pattern.test(text));
}

/**
 * Maps a provider failure onto the credential-pool action space. Credential-
 * scoped failures fail over (permanently for auth/billing, cooldown for rate
 * limits); provider-scoped faults (5xx/overload/network) retry the SAME slot
 * without blocking it, because blocking a healthy credential for a provider
 * outage only destroys prompt-cache locality; everything else fails the
 * request so the model fallback chain above keeps owning it.
 */
export function classifyCredentialFailure(error: unknown, context: { failureCount?: number } = {}): CredentialAction {
	const normalized = normalizeProviderError(error);
	const text = normalized.messageCarriesBody ? normalized.message : `${normalized.message} ${normalized.body ?? ""}`;
	const status = normalized.status;
	const failureCount = context.failureCount ?? 0;

	if (isAbort(error, text)) return { kind: "fail_request" };
	if (status === 401 || INVALID_KEY_TEXT.test(text)) {
		return { kind: "failover", block: { reason: "auth_error" } };
	}
	if (status === 403) {
		return ACCOUNT_SCOPED_403_TEXT.test(text)
			? { kind: "failover", block: { reason: "auth_error" } }
			: { kind: "fail_request" };
	}
	if (status === 402 || BILLING_TEXT.test(text)) {
		return { kind: "failover", block: { reason: "account_disabled" } };
	}
	if (status === 429 || RATE_LIMIT_TEXT.test(text)) {
		const hint = extract429RetryAfterMs({ status: status ?? 429, bodyText: text });
		return { kind: "failover", block: { reason: "rate_limit", ...rateLimitCooldown(failureCount, hint) } };
	}
	if (isOverflowText(text) || status === 400 || status === 404 || FAIL_FAST_TEXT.test(text)) {
		return { kind: "fail_request" };
	}
	if (status === 529 || OVERLOAD_TEXT.test(text) || (status !== undefined && status >= 500 && status < 600)) {
		return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
	}
	if (status === 408 || NETWORK_TEXT.test(text)) {
		return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
	}
	return { kind: "fail_request" };
}
