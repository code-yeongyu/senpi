import type {
	ProviderDiagnostic,
	ProviderDiagnosticCategory,
	ProviderDiagnosticEvidence,
} from "../provider-diagnostic.ts";

/** Serialized UTF-8 budget for one emitted diagnostic. */
export const PROVIDER_DIAGNOSTIC_MAX_BYTES = 512;

/**
 * Closed allowlist of provider error tokens and the family each one proves.
 * Exact tokens only: Anthropic `error.type` values and OpenAI-compatible
 * `error.code` values. `billing_error` proves a billing failure, not quota
 * exhaustion, so it stays `unknown`.
 */
export function categoryForProviderCode(code: string): ProviderDiagnosticCategory | undefined {
	switch (code) {
		case "authentication_error":
		case "invalid_api_key":
			return "auth";
		case "rate_limit_error":
		case "rate_limit_exceeded":
			return "rate_limit";
		case "insufficient_quota":
			return "quota";
		case "context_length_exceeded":
			return "context_limit";
		case "invalid_request_error":
			return "invalid_request";
		case "overloaded_error":
		case "api_error":
		case "timeout_error":
			return "provider_unavailable";
		case "billing_error":
		case "permission_error":
		case "not_found_error":
			return "unknown";
		default:
			return undefined;
	}
}

/** The HTTP status a recognized token may arrive with; anything else is contradictory evidence. */
export function isProviderCodeStatusCompatible(code: string, status: number): boolean {
	switch (code) {
		case "authentication_error":
		case "invalid_api_key":
			return status === 401;
		case "rate_limit_error":
		case "rate_limit_exceeded":
		case "insufficient_quota":
			return status === 429;
		case "context_length_exceeded":
		case "invalid_request_error":
			return status === 400;
		case "overloaded_error":
		case "api_error":
		case "timeout_error":
			return status >= 500 && status <= 599;
		case "billing_error":
			return status === 402;
		case "permission_error":
			return status === 403;
		case "not_found_error":
			return status === 404;
		default:
			return false;
	}
}

/** Status-only family. 402/403/429 alone cannot tell quota, auth and rate limit apart. */
export function categoryForProviderStatus(status: number): ProviderDiagnosticCategory {
	if (status === 401) return "auth";
	if (status === 400) return "invalid_request";
	if (status >= 500 && status <= 599) return "provider_unavailable";
	return "unknown";
}

export function isProviderDiagnosticStatus(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
}

export function isProviderDiagnosticCategory(value: unknown): value is ProviderDiagnosticCategory {
	switch (value) {
		case "auth":
		case "rate_limit":
		case "quota":
		case "context_limit":
		case "invalid_request":
		case "provider_unavailable":
		case "unknown":
			return true;
		default:
			return false;
	}
}

/** Fresh flat object, one field at a time, dropped when it exceeds the byte budget. */
export function buildProviderDiagnostic(input: {
	category: ProviderDiagnosticCategory;
	httpStatus?: number;
	code?: string;
	evidence: ProviderDiagnosticEvidence;
}): ProviderDiagnostic | undefined {
	const diagnostic: ProviderDiagnostic = { category: input.category, evidence: input.evidence };
	if (input.httpStatus !== undefined) diagnostic.httpStatus = input.httpStatus;
	if (input.code !== undefined) diagnostic.code = input.code;
	const size = new TextEncoder().encode(JSON.stringify(diagnostic)).length;
	return size <= PROVIDER_DIAGNOSTIC_MAX_BYTES ? diagnostic : undefined;
}

export interface ProviderFailureFacts {
	/** Status read from the transport error; `undefined` for an in-stream error. */
	readonly status: unknown;
	readonly code: string | undefined;
}

/**
 * Classify already-extracted structured facts. A supplied status that is not a
 * valid 4xx/5xx integer, or a recognized code that contradicts the status,
 * yields nothing. An unrecognized code proves nothing and is discarded; a valid
 * status may still classify on its own.
 */
export function classifyProviderFailure(facts: ProviderFailureFacts): ProviderDiagnostic | undefined {
	const statusSupplied = facts.status !== undefined && facts.status !== null;
	if (statusSupplied && !isProviderDiagnosticStatus(facts.status)) return undefined;
	const status = statusSupplied && isProviderDiagnosticStatus(facts.status) ? facts.status : undefined;
	const category = facts.code === undefined ? undefined : categoryForProviderCode(facts.code);
	if (facts.code !== undefined && category !== undefined) {
		if (status !== undefined && !isProviderCodeStatusCompatible(facts.code, status)) return undefined;
		return buildProviderDiagnostic({
			category,
			...(status === undefined ? {} : { httpStatus: status }),
			code: facts.code,
			evidence: "structured_code",
		});
	}
	if (status === undefined) return undefined;
	return buildProviderDiagnostic({
		category: categoryForProviderStatus(status),
		httpStatus: status,
		evidence: "structured_status",
	});
}
