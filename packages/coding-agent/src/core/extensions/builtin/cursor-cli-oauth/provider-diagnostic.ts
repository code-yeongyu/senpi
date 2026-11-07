import { type ProviderDiagnostic, sanitizeProviderDiagnostic } from "@earendil-works/pi-ai";
import { AllCursorAccountsBlockedError } from "./affinity.ts";

const CAUSE_DEPTH = 8;

function poolRefusal(error: unknown): AllCursorAccountsBlockedError | undefined {
	let current = error;
	for (let depth = 0; depth < CAUSE_DEPTH && current instanceof Error; depth++) {
		if (current instanceof AllCursorAccountsBlockedError) return current;
		current = current.cause;
	}
	return undefined;
}

/**
 * The providerDiagnostic for a Cursor CLI OAuth turn the extension refused locally (senpi#4092), mirroring
 * the Anthropic Subscription lane (senpi#4672). Cursor blocks an account either for a rate limit, which carries
 * an expiry, or for a failed login, which carries none: a refusal with a soonest expiry is `rate_limit` with that
 * reset, and one without any is `auth`, because only a new login brings an account back.
 */
export function cursorCliDiagnostic(error: unknown): ProviderDiagnostic | undefined {
	const pool = poolRefusal(error);
	if (pool === undefined) return undefined;
	if (pool.soonestUnblockAt === undefined) {
		return sanitizeProviderDiagnostic({
			category: "auth",
			code: "account_pool_auth_blocked",
			evidence: "structured_code",
		});
	}
	return sanitizeProviderDiagnostic({
		category: "rate_limit",
		code: "account_pool_blocked",
		evidence: "structured_code",
		resetsAt: pool.soonestUnblockAt,
	});
}
