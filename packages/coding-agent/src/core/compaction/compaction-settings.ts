import { DEFAULT_IDEAL_COMPACTION_SETTINGS, type IdealCompactionSettings } from "./ideal-compaction-settings.ts";

export interface CompactionSettings extends IdealCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	speculativeEnabled?: boolean;
	speculativeFraction?: number;
	speculativeCooldownMs?: number;
	restorationEnabled?: boolean;
	restorationMaxItems?: number;
	restorationMaxTokensPerItem?: number;
	restorationMaxTotalTokens?: number;
	restorationContextRatio?: number;
	idleCompactionEnabled?: boolean;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	speculativeEnabled: true,
	speculativeFraction: 0.75,
	speculativeCooldownMs: 30000,
	restorationEnabled: true,
	restorationMaxItems: 10,
	restorationMaxTokensPerItem: 5000,
	restorationMaxTotalTokens: 50_000,
	restorationContextRatio: 0.15,
	idleCompactionEnabled: true,
	...DEFAULT_IDEAL_COMPACTION_SETTINGS,
};
