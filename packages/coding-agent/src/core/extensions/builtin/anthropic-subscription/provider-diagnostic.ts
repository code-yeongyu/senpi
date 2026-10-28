import {
	type ProviderDiagnostic,
	type ProviderDiagnosticCategory,
	sanitizeProviderDiagnostic,
} from "@earendil-works/pi-ai";
import { AllAccountsBlockedError } from "./affinity.ts";
import { classifySdkError, type SdkErrorKind } from "./errors.ts";
import { ClassifiedSdkError } from "./failover.ts";

/** The allowlisted provider token each classified SDK failure proves; kinds that prove nothing map to none. */
const SDK_KIND_DIAGNOSTICS: Partial<
	Record<SdkErrorKind, { readonly category: ProviderDiagnosticCategory; readonly code: string }>
> = {
	auth_error: { category: "auth", code: "authentication_error" },
	rate_limit: { category: "rate_limit", code: "rate_limit_error" },
	overloaded: { category: "provider_unavailable", code: "overloaded_error" },
	billing: { category: "unknown", code: "billing_error" },
	org_not_allowed: { category: "unknown", code: "permission_error" },
};

/**
 * The providerDiagnostic for an Anthropic Subscription turn failure (senpi#4672), mirroring the
 * chatgpt-subscription adapter (senpi#3771). A pool the extension refused locally is `auth` when every
 * account waits on a new login, otherwise `rate_limit` with the soonest retry; a classified SDK failure maps
 * to its provider token. The result is revalidated against the closed vocabulary, so nothing else escapes.
 */
export function anthropicSubscriptionDiagnostic(error: unknown): ProviderDiagnostic | undefined {
	if (error instanceof AllAccountsBlockedError) {
		// A pin to an account that is no longer configured is a configuration error, not a limit: no diagnostic.
		if (error.unavailableAccount?.configured === false) return undefined;
		const auth = error.blockReason === "auth_error";
		return sanitizeProviderDiagnostic({
			category: auth ? "auth" : "rate_limit",
			code: auth ? "account_pool_auth_blocked" : "account_pool_blocked",
			evidence: "structured_code",
			...(auth || error.soonestUnblockAt === undefined ? {} : { resetsAt: error.soonestUnblockAt }),
		});
	}
	const kind = error instanceof ClassifiedSdkError ? error.classification.kind : classifySdkError(error).kind;
	const mapped = SDK_KIND_DIAGNOSTICS[kind];
	return mapped === undefined ? undefined : sanitizeProviderDiagnostic({ ...mapped, evidence: "structured_code" });
}
