import type { AssistantMessage } from "@earendil-works/pi-ai";
import { extract429RetryAfterMs, parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import { usageLimitResetMs } from "../credential-pool/reset-time.ts";

/**
 * The wall-clock moment (epoch ms) a failed request's limit lifts, when the failure names one:
 * the adapter's structured quota/rate-limit reset first, then usage-limit reset prose or fields,
 * then a Retry-After hint. Undefined when the failure names no future reset.
 */
export function limitResetAt(
	message: Pick<AssistantMessage, "errorMessage" | "providerDiagnostic">,
	wallNow: number,
): number | undefined {
	const diagnostic = message.providerDiagnostic;
	const resetsAt = diagnostic?.resetsAt;
	if (
		(diagnostic?.category === "quota" || diagnostic?.category === "rate_limit") &&
		resetsAt !== undefined &&
		Number.isFinite(resetsAt) &&
		resetsAt > wallNow
	) {
		return resetsAt;
	}
	const text = message.errorMessage ?? "";
	const resetMs =
		usageLimitResetMs(text, wallNow) ?? parseRetryAfterMsMarker(text) ?? extract429RetryAfterMs({ bodyText: text });
	return resetMs !== undefined && Number.isFinite(resetMs) && resetMs > 0 ? wallNow + resetMs : undefined;
}
