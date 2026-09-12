import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "./sdk-boundary.ts";

export type SdkErrorKind =
	| "rate_limit"
	| "overloaded"
	| "auth_error"
	| "billing"
	| "org_not_allowed"
	| "entitlement"
	| "other";

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
	account_on_hold: { kind: "billing", retryable: true },
	model_not_found: { kind: "other", retryable: false },
	max_output_tokens: { kind: "other", retryable: false },
};

const OTHER_ERROR: SdkErrorClassification = { kind: "other", retryable: false };

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

export type SdkResultUsage = Extract<SDKMessage, { type: "result" }>["usage"];

/** A failed SDK result keeps the usage it billed so every lane can account for it. */
export class SdkResultFailure extends Error {
	readonly usage: SdkResultUsage | undefined;

	constructor(message: string, usage: SdkResultUsage | undefined) {
		super(message);
		this.name = "SdkResultFailure";
		this.usage = usage;
	}
}

/** The usage carried by a failed SDK result, looking through failover's classification wrapper. */
export function sdkResultFailureUsage(error: unknown): SdkResultUsage | undefined {
	if (error instanceof SdkResultFailure) return error.usage;
	const wrapped = record(error)?.original;
	return wrapped instanceof SdkResultFailure ? wrapped.usage : undefined;
}

export function sdkResultFailure(message: Extract<SDKMessage, { type: "result" }>): SdkResultFailure | undefined {
	if (message.subtype === "success" && message.is_error !== true) return undefined;
	const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
	const firstError = errors.find((error): error is string => typeof error === "string" && error.length > 0);
	const resultText = "result" in message && typeof message.result === "string" ? message.result.trim() : "";
	const detail =
		firstError ??
		(message.is_error === true && resultText ? resultText : undefined) ??
		`Claude Code ${message.subtype}`;
	const status =
		"api_error_status" in message && message.api_error_status != null ? `HTTP ${message.api_error_status}` : "";
	const reason =
		"terminal_reason" in message && typeof message.terminal_reason === "string" ? message.terminal_reason : "";
	const suffix = [status, reason].filter(Boolean).join(", ");
	return new SdkResultFailure(suffix ? `${detail} (${suffix})` : detail, message.usage);
}

export function sdkAssistantFailure(message: Extract<SDKMessage, { type: "assistant" }>): Error | undefined {
	if (!message.error) return undefined;
	const content = message.message.content;
	const text = (
		typeof content === "string"
			? content
			: content
					.filter((block) => block.type === "text" && "text" in block && typeof block.text === "string")
					.map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
					.join(" ")
	).trim();
	return new Error(text ? (message.error === "unknown" ? text : `${text} (${message.error})`) : message.error);
}

/** Classifies Claude SDK OAuth error codes and HTTP-shaped fallback text in one place. */
export function classifySdkError(error: unknown): SdkErrorClassification {
	const text = errorText(error).toLowerCase();
	if (
		/\b(enotfound|eai_again|econnreset|econnrefused|etimedout|enetunreach|ehostunreach|und_err_connect_timeout|und_err_socket)\b|fetch failed|socket hang up|connection reset by peer/.test(
			text,
		)
	) {
		return { kind: "other", retryable: true };
	}
	for (const [code, classification] of Object.entries(SDK_ERROR_CLASSIFICATIONS)) {
		if (new RegExp(`\\b${code}\\b`).test(text)) return classification ?? OTHER_ERROR;
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
	if (/\binvalid_grant\b|\binvalid_token\b|\b(?:http\s*)?401\b|\bunauthorized\b/.test(text)) {
		return { kind: "auth_error", retryable: true };
	}
	// Fable 5 and similar models are not in the subscription; Claude Code asks
	// for usage credits. That is an account entitlement, not a 60s rate limit:
	// blocking the only account would also block Opus fallback on it.
	if (/\brequires usage credits\b|\/usage-credits\b|\bcredits_required\b/.test(text)) {
		return { kind: "entitlement", retryable: false };
	}
	return OTHER_ERROR;
}
