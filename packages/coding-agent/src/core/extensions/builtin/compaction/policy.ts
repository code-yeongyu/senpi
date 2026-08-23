import type { CompactionSettings } from "../../../compaction/index.ts";
import type { ContextUsage } from "../../types.ts";

const MIN_ADAPTIVE_THRESHOLD_RATIO = 0.4;
const MAX_ADAPTIVE_THRESHOLD_RATIO = 0.7;
const HIGH_YIELD_SAVING_RATIO = 0.5;
const LOW_YIELD_SAVING_RATIO = 0.1;
const YIELD_ADJUSTMENT_RATIO = 0.05;
const MIN_EFFECTIVE_KEEP_RECENT_TOKENS = 1024;

export const SPECULATIVE_FRACTION = 0.75;
export const DEFAULT_1M_CEILING = 384_000;
export const DEFAULT_1M_KEEP_RECENT = 35_000;
export const DEFAULT_STANDARD_KEEP_RECENT = 20_000;
export const DEFAULT_WARMUP_FRACTION = 0.75;
export const DEFAULT_TARGET_ACTIVE_FRACTION = 0.6;
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const LARGE_WINDOW_THRESHOLD = 500_000;

export interface ContextBudgetPolicy {
	physicalContextWindow: number;
	maxActiveContextTokens: number;
	keepRecentTokens: number;
	warmupFraction: number;
	targetActiveFraction: number;
	reserveTokens: number;
	emergencyHardLimitTokens: number;
}

export interface CompactionYield {
	savedTokens: number;
	tokensBefore: number;
}

export function isLargeContextModel(contextWindow: number): boolean {
	return contextWindow >= LARGE_WINDOW_THRESHOLD;
}

export function resolveContextBudgetPolicy(
	contextWindow: number,
	settings?: Partial<CompactionSettings>,
): ContextBudgetPolicy {
	const isLarge = isLargeContextModel(contextWindow);
	const reserveTokens = settings?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const defaultCeiling = isLarge ? DEFAULT_1M_CEILING : Math.max(0, contextWindow - reserveTokens);
	const configuredCeiling =
		settings?.maxContextTokens && settings.maxContextTokens > 0 ? settings.maxContextTokens : defaultCeiling;

	const maxActiveContextTokens = Math.min(Math.max(0, contextWindow - reserveTokens), configuredCeiling);

	const defaultKeepRecent = isLarge ? DEFAULT_1M_KEEP_RECENT : DEFAULT_STANDARD_KEEP_RECENT;
	const keepRecentTokens =
		settings?.keepRecentTokensConfigured === false
			? defaultKeepRecent
			: (settings?.keepRecentTokens ?? defaultKeepRecent);
	const warmupFraction = settings?.speculativeFraction ?? DEFAULT_WARMUP_FRACTION;
	const targetActiveFraction = DEFAULT_TARGET_ACTIVE_FRACTION;
	const emergencyHardLimitTokens = Math.max(0, contextWindow - Math.floor(reserveTokens / 2));

	return {
		physicalContextWindow: contextWindow,
		maxActiveContextTokens,
		keepRecentTokens,
		warmupFraction,
		targetActiveFraction,
		reserveTokens,
		emergencyHardLimitTokens,
	};
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

function adjustEffectiveThresholdRatio(ratio: number, savedTokens: number, tokensBefore: number): number {
	if (tokensBefore <= 0) {
		return ratio;
	}

	const savedRatio = savedTokens / tokensBefore;
	if (savedRatio > HIGH_YIELD_SAVING_RATIO) {
		return ratio - YIELD_ADJUSTMENT_RATIO;
	}
	if (savedRatio < LOW_YIELD_SAVING_RATIO) {
		return ratio + YIELD_ADJUSTMENT_RATIO;
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
		ratio = adjustEffectiveThresholdRatio(ratio, lastYield.savedTokens, lastYield.tokensBefore);
	}
	return clampThresholdRatio(ratio);
}

export function computeEffectiveBlockingThresholdTokens(
	contextWindow: number,
	settings?: Partial<CompactionSettings>,
	lastYield?: CompactionYield | number,
): number {
	const ratio = computeEffectiveThreshold(contextWindow, lastYield);
	const ratioTokens = Math.floor(contextWindow * ratio);
	if (isLargeContextModel(contextWindow) || (settings?.maxContextTokens && settings.maxContextTokens > 0)) {
		const policy = resolveContextBudgetPolicy(contextWindow, settings);
		return Math.min(ratioTokens, policy.maxActiveContextTokens);
	}
	return ratioTokens;
}

export function computeEffectiveKeepRecentTokens(
	setting: number,
	contextWindow: number,
	thresholdRatio: number,
	margin = 0.05,
	settingConfigured = true,
): number {
	const isLarge = isLargeContextModel(contextWindow);
	const defaultForModel = isLarge ? DEFAULT_1M_KEEP_RECENT : DEFAULT_STANDARD_KEEP_RECENT;
	const effectiveSetting = settingConfigured ? setting : defaultForModel;
	const capped = Math.floor(contextWindow * (1 - thresholdRatio - margin));
	return Math.min(effectiveSetting, Math.max(MIN_EFFECTIVE_KEEP_RECENT_TOKENS, capped));
}

export function shouldStartSpeculativeCompaction(
	usage: ContextUsage,
	contextWindow: number,
	settings: CompactionSettings,
	lastYield?: CompactionYield,
): boolean {
	if (settings.speculativeEnabled === false || usage.tokens === null || contextWindow <= 0) {
		return false;
	}

	const policy = resolveContextBudgetPolicy(contextWindow, settings);
	const blockingThreshold = computeEffectiveBlockingThresholdTokens(contextWindow, settings, lastYield);
	const warmupThreshold = Math.floor(blockingThreshold * policy.warmupFraction);
	return usage.tokens >= warmupThreshold;
}

export function isAtHardLimit(
	usage: ContextUsage,
	contextWindow: number,
	reserveTokens: number,
	additionalTokens = 0,
): boolean {
	return usage.tokens !== null && usage.tokens + additionalTokens + reserveTokens >= contextWindow;
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

	const blockingThreshold = computeEffectiveBlockingThresholdTokens(contextWindow, settings, lastYield);
	return usage.tokens >= blockingThreshold;
}
