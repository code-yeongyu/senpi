import { isQuotaExhaustionMessage } from "@earendil-works/pi-ai";
import { rateLimitModelFamily } from "../credential-pool/model-scope.ts";
import { isBillingErrorMessage } from "./billing.ts";

/**
 * Who a usage limit binds. `model`: the provider refused THIS model only (a
 * Fable-only weekly cap, premium models on a Copilot plan, a model that needs
 * usage credits), so its siblings on the same account still serve. `account`:
 * the credential itself is spent (a session or weekly cap, a monthly quota, an
 * empty balance), so every other model on that provider fails the same way and
 * the chain moves to another provider instead.
 */
export type UsageLimitScope = "model" | "account";

// Subscription limit prose that carries no quota/billing keyword, e.g. Claude's
// "You've hit your session limit · resets 3pm" and the SDK terminal reasons.
const SUBSCRIPTION_LIMIT_PATTERN =
	/\bhit\s+your\b[^.]*\blimit\b|\b(?:session|weekly|monthly|daily|hourly|\d+[- ]hour|usage)\s+limit\b|\bblocking_limit\b|\brapid_refill_breaker\b/i;
// A plan cap that tells the user to switch models, e.g. Devin's "Reached free model rate limit. ...
// switch to a different model" (senpi#2660). An ordinary "rate limit exceeded" stays transient.
const PLAN_MODEL_LIMIT_PATTERN =
	/\breached\b[^.]*\b(?:free|plan|tier|model)\b[^.]*\blimit\b[\s\S]*\bswitch to (?:a |an )?(?:different|another) model\b/i;
const MODEL_SCOPE_PATTERN = /\bmodels?\b|\bpremium\b|\b(?:opus|sonnet|haiku|fable|mythos)\b/i;

export function usageLimitScope(errorMessage: string | undefined): UsageLimitScope | undefined {
	if (errorMessage === undefined) return undefined;
	// Claude Code's "You've reached your Fable limit. Switch to another model" carries
	// none of the keywords below, yet it names the one family it binds (senpi#2555).
	if (rateLimitModelFamily(errorMessage) !== undefined) return "model";
	const limited =
		isQuotaExhaustionMessage(errorMessage) ||
		isBillingErrorMessage(errorMessage) ||
		SUBSCRIPTION_LIMIT_PATTERN.test(errorMessage) ||
		PLAN_MODEL_LIMIT_PATTERN.test(errorMessage);
	if (!limited) return undefined;
	return MODEL_SCOPE_PATTERN.test(errorMessage) ? "model" : "account";
}

/** The notice clause naming what hit the limit, or undefined when no usage limit caused the switch. */
export function usageLimitCause(from: string, limit: UsageLimitScope | undefined): string | undefined {
	if (limit === "model") return `${from} hit its usage limit`;
	if (limit === "account") {
		const provider = from.slice(0, Math.max(0, from.indexOf("/"))) || from;
		return `the ${provider} account hit its usage limit, so its other models were skipped`;
	}
	return undefined;
}
