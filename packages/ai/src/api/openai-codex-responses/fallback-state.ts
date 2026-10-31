import { formatThrownValue } from "../../utils/diagnostics.ts";

export const CODEX_WEBSOCKET_FALLBACK_COOLDOWN_MS = 60_000;
/**
 * Mid-stream WebSocket failures in a row, with no completed WebSocket response
 * between them, before the session moves to SSE. One drop is transient: the
 * retry opens a fresh WebSocket, as upstream Codex does (senpi#3442).
 */
export const CODEX_WEBSOCKET_MID_STREAM_FAILURES_BEFORE_FALLBACK = 2;

export type WebSocketFailurePhase = "before_message_stream_start" | "after_message_stream_start";

export interface ChatGptSubscriptionWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

const websocketDebugStats = new Map<string, ChatGptSubscriptionWebSocketDebugStats>();
const websocketSseFallbackUntil = new Map<string, number>();
const consecutiveMidStreamFailures = new Map<string, number>();

export function getOrCreateWebSocketDebugStats(sessionId: string): ChatGptSubscriptionWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function getWebSocketDebugStats(sessionId: string): ChatGptSubscriptionWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function clearWebSocketFallbackState(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackUntil.delete(sessionId);
		consecutiveMidStreamFailures.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackUntil.clear();
	consecutiveMidStreamFailures.clear();
}

export function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	if (!sessionId) return false;
	const fallbackUntil = websocketSseFallbackUntil.get(sessionId);
	if (fallbackUntil === undefined) return false;

	const stats = websocketDebugStats.get(sessionId);
	if (fallbackUntil > Date.now()) {
		if (stats) stats.websocketFallbackActive = true;
		return true;
	}

	websocketSseFallbackUntil.delete(sessionId);
	if (stats) stats.websocketFallbackActive = false;
	return false;
}

export function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = true;
}

/**
 * A failure before any output arms the SSE cooldown at once, because that same
 * request is retried over SSE. A failure after output started is retried by the
 * caller; it arms the cooldown only once it repeats without a completed
 * WebSocket response in between. Aborts and non-transport errors never reach
 * here, so they neither count nor reset the run.
 */
export function recordWebSocketFailure(
	sessionId: string | undefined,
	error: unknown,
	phase: WebSocketFailurePhase,
): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);

	if (phase === "after_message_stream_start") {
		const failures = (consecutiveMidStreamFailures.get(sessionId) ?? 0) + 1;
		if (failures < CODEX_WEBSOCKET_MID_STREAM_FAILURES_BEFORE_FALLBACK) {
			consecutiveMidStreamFailures.set(sessionId, failures);
			return;
		}
	}
	consecutiveMidStreamFailures.delete(sessionId);
	websocketSseFallbackUntil.set(sessionId, Date.now() + CODEX_WEBSOCKET_FALLBACK_COOLDOWN_MS);
	stats.websocketFallbackActive = true;
}

/** A completed WebSocket response ends a run of mid-stream failures. */
export function recordWebSocketSuccess(sessionId: string | undefined): void {
	if (sessionId) consecutiveMidStreamFailures.delete(sessionId);
}
