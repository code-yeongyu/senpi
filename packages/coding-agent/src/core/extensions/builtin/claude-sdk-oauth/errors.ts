import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

export type SdkErrorKind = "rate_limit" | "overloaded" | "auth_error" | "billing" | "org_not_allowed" | "other";

export type SdkErrorClassification = {
	kind: SdkErrorKind;
	retryable: boolean;
};

const SDK_ERROR_CLASSIFICATIONS: Partial<Record<SDKAssistantMessageError, SdkErrorClassification>> = {
	authentication_failed: { kind: "auth_error", retryable: true },
	oauth_org_not_allowed: { kind: "org_not_allowed", retryable: true },
	billing_error: { kind: "billing", retryable: true },
	rate_limit: { kind: "rate_limit", retryable: true },
	overloaded: { kind: "overloaded", retryable: true },
	invalid_request: { kind: "other", retryable: false },
	server_error: { kind: "other", retryable: true },
};

const OTHER_ERROR: SdkErrorClassification = { kind: "other", retryable: false };
const TRANSIENT_NETWORK_ERROR: SdkErrorClassification = { kind: "other", retryable: true };
const AUTH_ERROR: SdkErrorClassification = { kind: "auth_error", retryable: true };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function errorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	const value = record(error);
	if (!value) return String(error);
	const message = value.message;
	if (typeof message === "string") return message;
	const code = value.error;
	if (typeof code === "string") return code;
	return String(error);
}

/** Classifies Claude SDK OAuth error codes and HTTP-shaped fallback text in one place. */
export function classifySdkError(error: unknown): SdkErrorClassification {
	const text = errorText(error).toLowerCase();
	// Transport failures during token refresh do not say anything about token
	// validity. Match them before `authentication_failed` because the auth lane
	// wraps every refresh exception with that SDK-compatible prefix.
	if (
		/\b(?:enotfound|eai_again|econnreset|econnrefused|etimedout|enetworkdown|enetunreach|ehostunreach|und_err_connect_timeout|und_err_socket)\b|fetch failed|network(?: request)? (?:failed|error)|socket hang up|connection reset by peer/.test(
			text,
		)
	) {
		return TRANSIENT_NETWORK_ERROR;
	}
	for (const [code, classification] of Object.entries(SDK_ERROR_CLASSIFICATIONS)) {
		if (new RegExp(`\\b${code}\\b`).test(text)) return classification;
	}
	if (
		/\binvalid_grant\b|\binvalid_token\b|\btoken\b[^.]*\brevoked\b|\b(?:http\s*)?401\b|\bunauthorized\b/.test(text)
	) {
		return AUTH_ERROR;
	}
	if (/\b(?:http\s*)?429\b|too many requests|rate[ _-]?limit/.test(text)) {
		return { kind: "rate_limit", retryable: true };
	}
	// Claude Code signals subscription exhaustion two ways, neither of which
	// carries an SDK error code or HTTP status:
	//   - `terminal_reason: "blocking_limit"` / `"rapid_refill_breaker"` on a
	//     result message (surfaced by auth-lane's sdkFailure)
	//   - prose in `errors[0]`, e.g. "You've hit your weekly limit · resets 5am
	//     (Asia/Seoul)" and the 5-hour/daily equivalents
	// Without these branches both classify as non-retryable "other", so the
	// exhausted account is never blocked and a pool never rotates past it.
	if (/\bblocking_limit\b|\brapid_refill_breaker\b/.test(text)) {
		return { kind: "rate_limit", retryable: true };
	}
	if (/\b(?:hit|reached|exceeded)\b[^.]*\blimit\b|\b(?:weekly|daily|hourly|usage)\s+limit\b/.test(text)) {
		return { kind: "rate_limit", retryable: true };
	}
	if (/\b(?:http\s*)?529\b|overloaded/.test(text)) return { kind: "overloaded", retryable: true };
	return OTHER_ERROR;
}
