import { peekProviderDiagnostic } from "./utils/provider-diagnostic-carrier.ts";
import {
	buildProviderDiagnostic,
	categoryForProviderCode,
	categoryForProviderStatus,
	isProviderCodeStatusCompatible,
	isProviderDiagnosticCategory,
	isProviderDiagnosticStatus,
	PROVIDER_DIAGNOSTIC_MAX_BYTES,
} from "./utils/provider-diagnostic-vocabulary.ts";

/** Closed failure families. `unknown` is kept rather than guessed. */
export type ProviderDiagnosticCategory =
	| "auth"
	| "rate_limit"
	| "quota"
	| "context_limit"
	| "invalid_request"
	| "provider_unavailable"
	| "unknown";

/** Which structured provider field decided the category. */
export type ProviderDiagnosticEvidence = "structured_status" | "structured_code";

/**
 * Bounded, redaction-safe classification of a provider rejection, minted only by
 * a provider adapter from structured metadata (the SDK HTTP error its own
 * transport call raised, or an explicit SSE error envelope). It is additive: it
 * never changes `errorMessage`, retries, fallback, or exit codes.
 */
export interface ProviderDiagnostic {
	category: ProviderDiagnosticCategory;
	/** Integer 400..599. Absent for an error delivered inside an HTTP 200 stream. */
	httpStatus?: number;
	/** Provider token from the closed allowlist, never raw provider text. */
	code?: string;
	evidence: ProviderDiagnosticEvidence;
}

export { PROVIDER_DIAGNOSTIC_MAX_BYTES };

function readField(value: object, key: "category" | "evidence" | "httpStatus" | "code"): unknown {
	return Reflect.get(value, key);
}

/**
 * Revalidate a diagnostic that crossed a boundary (wire, persisted record,
 * agent state) and return a fresh canonical copy. The fields must describe the
 * one classification the fixed mapping implies; anything else is dropped whole.
 */
export function sanitizeProviderDiagnostic(value: unknown): ProviderDiagnostic | undefined {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const category = readField(value, "category");
		const evidence = readField(value, "evidence");
		const httpStatus = readField(value, "httpStatus");
		const code = readField(value, "code");
		if (!isProviderDiagnosticCategory(category)) return undefined;
		if (httpStatus !== undefined && !isProviderDiagnosticStatus(httpStatus)) return undefined;
		if (evidence === "structured_status") {
			if (code !== undefined || !isProviderDiagnosticStatus(httpStatus)) return undefined;
			if (category !== categoryForProviderStatus(httpStatus)) return undefined;
			return buildProviderDiagnostic({ category, httpStatus, evidence });
		}
		if (evidence !== "structured_code" || typeof code !== "string") return undefined;
		if (categoryForProviderCode(code) !== category) return undefined;
		if (httpStatus !== undefined && !isProviderCodeStatusCompatible(code, httpStatus)) return undefined;
		return buildProviderDiagnostic({
			category,
			...(httpStatus === undefined ? {} : { httpStatus }),
			code,
			evidence,
		});
	} catch {
		return undefined;
	}
}

/**
 * Read the diagnostic a provider adapter attached to a thrown error, as a fresh
 * validated copy. A `providerDiagnostic` property an error declares on itself
 * reads as absent.
 */
export function readProviderDiagnostic(error: unknown): ProviderDiagnostic | undefined {
	return sanitizeProviderDiagnostic(peekProviderDiagnostic(error));
}
