import { type AssistantMessage, isClassifierRefusal } from "@earendil-works/pi-ai";
import { isBillingErrorMessage } from "./billing.ts";
import { usageLimitScope } from "./usage-limit.ts";

/**
 * Why one model of a turn's fallback chain failed. `out_of_credit` is a pay-as-you-go API account with no
 * balance (Anthropic's "credit balance is too low", OpenAI's `insufficient_quota`); `billing` is any other
 * billing refusal (a spend cap); `usage_limit` is a plan or account limit that resets.
 */
export type FallbackAttemptReason = "out_of_credit" | "billing" | "usage_limit" | "refused" | "error";

export interface FallbackAttempt {
	readonly model: string;
	readonly reason: FallbackAttemptReason;
	readonly error: string;
}

const OUT_OF_CREDIT_PATTERN = /credit balance|insufficient_quota/i;

const REASON_TEXT: Record<FallbackAttemptReason, string> = {
	out_of_credit: "out of credit",
	billing: "billing",
	usage_limit: "usage limit",
	refused: "refused",
	error: "error",
};

export function classifyFallbackAttempt(message: AssistantMessage): FallbackAttemptReason {
	if (isClassifierRefusal(message)) return "refused";
	if (message.errorMessage !== undefined && OUT_OF_CREDIT_PATTERN.test(message.errorMessage)) return "out_of_credit";
	if (isBillingErrorMessage(message.errorMessage)) return "billing";
	if (usageLimitScope(message) !== undefined) return "usage_limit";
	return "error";
}

export function describeExhaustedChain(attempts: readonly FallbackAttempt[]): string {
	return [
		"Every model in this turn's fallback chain failed:",
		...attempts.map((attempt) => `- ${attempt.model}: ${REASON_TEXT[attempt.reason]} (${attempt.error})`),
	].join("\n");
}
