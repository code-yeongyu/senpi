import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { lastAssistantMessage } from "./last-assistant-message.ts";

export const PROVIDER_RETRY_BASE_MS = 15_000;
export const PROVIDER_RETRY_CAP_MS = 30 * 60_000;
export const PROVIDER_RETRY_WAKE_CAP_MS = 6 * 60 * 60_000;
const WAKE_MARGIN_MS = 1_000;

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;

function failureText(messages: readonly AgentMessage[]): string {
	return lastAssistantMessage(messages)?.errorMessage ?? "";
}

/**
 * The earliest future instant the failed turn's error names (never the assistant's own text), e.g. a credential pool's
 * "blocked until 2026-10-14T12:15:00.000Z": the moment an account frees up.
 */
export function providerRetryAt(messages: readonly AgentMessage[], now: number): number | undefined {
	const instants = [...failureText(messages).matchAll(ISO_INSTANT)]
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
