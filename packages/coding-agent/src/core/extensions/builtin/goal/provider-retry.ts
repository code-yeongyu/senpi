import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import { lastAssistantMessage } from "./last-assistant-message.ts";

export const PROVIDER_RETRY_BASE_MS = 15_000;
export const PROVIDER_RETRY_CAP_MS = 30 * 60_000;
export const PROVIDER_RETRY_WAKE_CAP_MS = 6 * 60 * 60_000;
const WAKE_MARGIN_MS = 1_000;

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;

/**
 * Prefer a provider's structured usage reset, then its retry-after marker. Legacy
 * pool guidance falls back to the earliest future ISO instant in the error only.
 */
export function providerRetryAt(messages: readonly AgentMessage[], now: number): number | undefined {
	const failure = lastAssistantMessage(messages);
	const diagnostic = failure?.providerDiagnostic;
	const reset = diagnostic?.resetsAt;
	if (
		(diagnostic?.category === "quota" || diagnostic?.category === "rate_limit") &&
		reset !== undefined &&
		Number.isFinite(reset) &&
		reset > now
	) {
		return reset;
	}
	const text = failure?.errorMessage ?? "";
	const retryAfterMs = parseRetryAfterMsMarker(text);
	if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
		return now + retryAfterMs;
	}
	const instants = [...text.matchAll(ISO_INSTANT)]
		.map((match) => Date.parse(match[0]))
		.filter((at) => Number.isFinite(at) && at > now);
	return instants.length === 0 ? undefined : Math.min(...instants);
}

/**
 * How long to wait before the `attempt`-th consecutive provider-recovery
 * continuation (senpi#3264). A stated unblock time is the wake; otherwise the
 * first retry is immediate and later ones back off exponentially, so a
 * provider that is certainly down is not hammered and the goal is still there
 * when it comes back.
 */
export function providerRetryDelayMs(attempt: number, retryAt: number | undefined, now: number): number {
	if (retryAt !== undefined) return Math.min(PROVIDER_RETRY_WAKE_CAP_MS, retryAt - now + WAKE_MARGIN_MS);
	if (attempt <= 1) return 0;
	return Math.min(PROVIDER_RETRY_CAP_MS, PROVIDER_RETRY_BASE_MS * 2 ** (attempt - 2));
}
