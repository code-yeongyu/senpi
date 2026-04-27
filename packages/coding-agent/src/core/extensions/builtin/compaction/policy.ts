import type { CompactionSettings } from "../../../compaction/index.js";
import type { ContextUsage } from "../../types.js";

const MIN_ADAPTIVE_THRESHOLD_RATIO = 0.4;
const MAX_ADAPTIVE_THRESHOLD_RATIO = 0.7;
const OMO_THRESHOLD_FLOOR_RATIO = 0.78;
const HIGH_YIELD_SAVING_RATIO = 0.5;
const LOW_YIELD_SAVING_RATIO = 0.1;
const YIELD_ADJUSTMENT_RATIO = 0.05;

export interface CompactionState {
	lastFailureAt: number | null;
}

export interface CompactionYield {
	savedTokens: number;
	tokensBefore: number;
}

function clampThresholdRatio(ratio: number): number {
	return Math.min(MAX_ADAPTIVE_THRESHOLD_RATIO, Math.max(MIN_ADAPTIVE_THRESHOLD_RATIO, ratio));
}

function adjustThresholdRatio(ratio: number, savedTokens: number, tokensBefore: number): number {
	if (tokensBefore <= 0) {
		return ratio;
	}

	const savedRatio = savedTokens / tokensBefore;
	if (savedRatio > HIGH_YIELD_SAVING_RATIO) {
		return clampThresholdRatio(ratio - YIELD_ADJUSTMENT_RATIO);
	}
	if (savedRatio < LOW_YIELD_SAVING_RATIO) {
		return clampThresholdRatio(ratio + YIELD_ADJUSTMENT_RATIO);
	}
	return ratio;
}

export function computeAdaptiveThresholdRatio(contextWindow: number, priorCompactionSavedTokens?: number): number {
	let ratio: number;
	if (!(contextWindow > 0)) {
		ratio = 0.5;
	} else if (contextWindow <= 16_000) {
		ratio = 0.45;
	} else if (contextWindow <= 32_000) {
		ratio = 0.5;
	} else if (contextWindow <= 64_000) {
		ratio = 0.55;
	} else if (contextWindow <= 128_000) {
		ratio = 0.6;
	} else {
		ratio = 0.65;
	}

	if (priorCompactionSavedTokens === undefined) {
		return ratio;
	}

	return adjustThresholdRatio(ratio, priorCompactionSavedTokens, contextWindow);
}

export function computeEffectiveThreshold(contextWindow: number, lastYield?: CompactionYield | number): number {
	if (typeof lastYield === "number") {
		return Math.max(contextWindow, lastYield);
	}

	let ratio = computeAdaptiveThresholdRatio(contextWindow);
	if (lastYield) {
		ratio = adjustThresholdRatio(ratio, lastYield.savedTokens, lastYield.tokensBefore);
	}
	return Math.max(ratio, OMO_THRESHOLD_FLOOR_RATIO);
}

export function shouldTriggerCompaction(
	usage: ContextUsage,
	contextWindow: number,
	settings: CompactionSettings,
	lastYield?: CompactionYield,
): boolean {
	if (!settings.enabled || usage.tokens === null || contextWindow <= 0) {
		return false;
	}

	return usage.tokens >= contextWindow * computeEffectiveThreshold(contextWindow, lastYield);
}

export const cooldownMs = 60000;

export function isInCooldown(state: CompactionState, now: number): boolean {
	return state.lastFailureAt !== null && now - state.lastFailureAt < cooldownMs;
}
