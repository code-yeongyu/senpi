import type { IdealCompactionSettings } from "./compaction/ideal-compaction-settings.ts";

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
}

export function compactionEnabled(settings?: CompactionSettings): boolean {
	return settings?.enabled ?? true;
}
export function compactionReserveTokens(settings?: CompactionSettings): number {
	return settings?.reserveTokens ?? 16384;
}
export function compactionKeepRecentTokens(settings?: CompactionSettings): number {
	return settings?.keepRecentTokens ?? 20000;
}
