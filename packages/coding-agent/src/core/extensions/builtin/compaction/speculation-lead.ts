export const SPECULATION_LEAD_MIN_TOKENS = 8192;
export const SPECULATION_LEAD_MAX_TOKENS = 32768;

export function resolveSpeculationLeadTokens(thresholdTokens: number, configuredLeadTokens?: number): number {
	const requestedLeadTokens = configuredLeadTokens ?? Math.floor(thresholdTokens * 0.125);
	return Math.min(SPECULATION_LEAD_MAX_TOKENS, Math.max(SPECULATION_LEAD_MIN_TOKENS, requestedLeadTokens));
}

export const WARM_GENERATION_FLOOR_RATIO = 0.5;

export function resolveGraceBandCapTokens(
	thresholdTokens: number,
	leadTokens: number,
	contextWindow: number,
	reserveTokens: number,
): number {
	return Math.min(thresholdTokens + leadTokens, contextWindow - reserveTokens);
}

export function isWithinGraceBand(
	contextTokens: number,
	thresholdTokens: number,
	leadTokens: number,
	contextWindow: number,
	reserveTokens: number,
): boolean {
	return contextTokens < resolveGraceBandCapTokens(thresholdTokens, leadTokens, contextWindow, reserveTokens);
}

export function isWarmResultStale(armedAtTokens: number, currentTokens: number, keepRecentTokens: number): boolean {
	return currentTokens - armedAtTokens > Math.max(keepRecentTokens, 8192);
}
