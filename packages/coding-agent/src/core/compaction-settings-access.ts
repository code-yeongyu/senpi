import type { Model } from "@earendil-works/pi-ai";
import type { IdealCompactionSettings } from "./compaction/ideal-compaction-settings.ts";

/** Token budgets overridden for one exact `provider/modelId` pair. */
export interface CompactionModelOverride {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

/** The identity a compaction budget is resolved for; the session model satisfies it. */
export type CompactionModelSelector = Pick<Model<string>, "provider" | "id">;

export interface CompactionSettings extends IdealCompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	speculativeEnabled?: boolean; // default: true
	speculativeFraction?: number; // default: 0.75
	speculativeCooldownMs?: number; // default: 30000
	restorationEnabled?: boolean; // default: true
	restorationMaxItems?: number; // default: 10
	restorationMaxTokensPerItem?: number; // default: 5000
	restorationMaxTotalTokens?: number; // default: 50000
	restorationContextRatio?: number; // default: 0.15
	idleCompactionEnabled?: boolean; // default: true
	/**
	 * Optional override for one summarization attempt's wall-clock budget.
	 * Default: size-adaptive (120s floor, 2ms per estimated input token, 30min
	 * cap); see `core/compaction/stream-watchdog.ts`.
	 */
	summarizationMaxDurationMs?: number;
	/** Per-model token budgets, keyed by the exact `provider/modelId` pair (no wildcards). */
	modelOverrides?: Record<string, CompactionModelOverride>;
}

const DEFAULT_COMPACTION_TOKEN_SETTINGS: Required<CompactionModelOverride> = {
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function compactionEnabled(settings?: CompactionSettings): boolean {
	return settings?.enabled ?? true;
}

/**
 * Resolve one token budget through the model override, then the ordinary setting,
 * then the built-in default. A configured-but-invalid value is an error rather than
 * a silent fallback, so a typo cannot quietly change the compaction budget.
 */
export function compactionTokenSetting(
	settings: CompactionSettings | undefined,
	field: keyof CompactionModelOverride,
	forModel?: CompactionModelSelector,
): number {
	const ordinary = settings?.[field];
	if (ordinary !== undefined && !isNonNegativeSafeInteger(ordinary)) {
		throw new Error(
			`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
		);
	}

	const modelKey = forModel ? `${forModel.provider}/${forModel.id}` : undefined;
	const entry = modelKey !== undefined ? settings?.modelOverrides?.[modelKey] : undefined;
	if (entry !== undefined && !isPlainObject(entry)) {
		throw new Error(
			`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
		);
	}
	const override = entry?.[field];
	if (override !== undefined && !isNonNegativeSafeInteger(override)) {
		throw new Error(
			`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
		);
	}
	return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
}

export function compactionReserveTokens(settings?: CompactionSettings, forModel?: CompactionModelSelector): number {
	return compactionTokenSetting(settings, "reserveTokens", forModel);
}
export function compactionKeepRecentTokens(settings?: CompactionSettings, forModel?: CompactionModelSelector): number {
	return compactionTokenSetting(settings, "keepRecentTokens", forModel);
}
