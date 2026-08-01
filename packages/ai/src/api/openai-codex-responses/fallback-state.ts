import { formatThrownValue } from "../../utils/diagnostics.ts";

export const CODEX_WEBSOCKET_FALLBACK_COOLDOWN_MS = 60_000;

export interface OpenAICodexWebSocketDebugStats {
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

const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackUntil = new Map<string, number>();

export function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
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

export function getWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function clearWebSocketFallbackState(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackUntil.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackUntil.clear();
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

export function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackUntil.set(sessionId, Date.now() + CODEX_WEBSOCKET_FALLBACK_COOLDOWN_MS);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}
