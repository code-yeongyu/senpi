import type { FallbackReason } from "./controller-types.ts";
import { isPureNetworkTransient } from "./transient-network.ts";
import { usageLimitScope } from "./usage-limit.ts";

// The model's serving capacity, not the caller's quota: a rate limit beside it stays route-bound.
const MODEL_OVERLOADED = /overloaded|\b529\b|high demand/;
const RATE_LIMITED = /rate[ -]?limit|\b429\b|too many requests/;

/**
 * Whether a failure belongs to the model rather than the route that served it, so the same model on another
 * provider would fail the same way within this walk (senpi#4083): a network blip on the model (the walk already
 * leaves every rung of it, senpi#3344), the model overloaded, or the model refusing the content (a refusal pins on
 * the premise that the same context refuses again). Account limits, billing, credentials, rate limits and server
 * errors are bound to one provider's route, so its same-model sibling stays a real second chance.
 */
export function isModelSharedFailure(reason: FallbackReason, errorMessage: string | undefined): boolean {
	if (reason === "refusal") return true;
	if (reason !== "transient" || errorMessage === undefined) return false;
	if (isPureNetworkTransient(errorMessage)) return true;
	const message = errorMessage.toLowerCase();
	return MODEL_OVERLOADED.test(message) && !RATE_LIMITED.test(message) && usageLimitScope(errorMessage) === undefined;
}
