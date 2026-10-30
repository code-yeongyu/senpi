import type { ProviderDiagnostic, ProviderDiagnosticCategory } from "../provider-diagnostic.ts";

type SiwcRecovery = "usage_limit" | "account_disabled" | "auth" | "request" | "transient";

/** Exact Responses codes, not prose: errors-and-recovery#structured-responses-errors. */
const SIWC_ERRORS: Readonly<
	Record<
		string,
		{
			readonly category: ProviderDiagnosticCategory;
			readonly status: number;
			readonly recovery: SiwcRecovery;
		}
	>
> = {
	subscription_sharing_usage_limit_exceeded: { category: "quota", status: 429, recovery: "usage_limit" },
	subscription_sharing_user_not_eligible: { category: "unknown", status: 403, recovery: "account_disabled" },
	subscription_sharing_usage_unavailable: { category: "provider_unavailable", status: 503, recovery: "transient" },
	subscription_sharing_user_unavailable: { category: "provider_unavailable", status: 503, recovery: "transient" },
	subscription_sharing_invalid_user: { category: "auth", status: 401, recovery: "auth" },
	subscription_sharing_unsupported_capability: { category: "invalid_request", status: 400, recovery: "request" },
	subscription_sharing_route_not_supported: { category: "invalid_request", status: 403, recovery: "request" },
	chatpass_v2_scope_not_authorized: { category: "invalid_request", status: 403, recovery: "request" },
	chatpass_v2_invalid_authorization_context: { category: "invalid_request", status: 403, recovery: "request" },
};

export function siwcErrorForCode(code: string) {
	return Object.hasOwn(SIWC_ERRORS, code) ? SIWC_ERRORS[code] : undefined;
}

/** Shared by HTTP retry, assistant retry, and the credential pool; unknown codes stay unknown. */
export function siwcRecoveryFromDiagnostic(diagnostic: ProviderDiagnostic | undefined): SiwcRecovery | undefined {
	if (diagnostic?.evidence === "structured_code" && diagnostic.code !== undefined) {
		return siwcErrorForCode(diagnostic.code)?.recovery;
	}
	// A direct-admission detail body has no code. Route provenance is necessary here:
	// a generic provider's 403 must retain its existing credential policy.
	if (diagnostic?.route !== "siwc" || diagnostic.evidence !== "structured_status") return undefined;
	switch (diagnostic.httpStatus) {
		case 401:
			return "auth";
		case 403:
			return "request";
		case 503:
			return "transient";
		default:
			return undefined;
	}
}
