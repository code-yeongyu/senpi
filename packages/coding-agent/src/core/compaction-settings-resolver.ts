import type { CompactionSettings } from "./compaction-settings-access.ts";

export interface ResolvedCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	speculativeEnabled: boolean;
	speculativeFraction: number;
	speculativeCooldownMs: number;
	restorationEnabled: boolean;
	restorationMaxItems: number;
	restorationMaxTokensPerItem: number;
	restorationMaxTotalTokens: number;
	restorationContextRatio: number;
	idleCompactionEnabled: boolean;
	graceBandEnabled: boolean;
	toolAdmissionEnabled: boolean;
	reminderEnabled: boolean;
	reserveScalingEnabled: boolean;
	speculativeLeadTokens?: number;
}

const DEFAULTS = {
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
	graceBandEnabled: true,
	toolAdmissionEnabled: true,
	reminderEnabled: true,
	reserveScalingEnabled: true,
} as const;

function finiteNumber(value: unknown, fallback: number, minimum = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

export function resolveCompactionSettings(settings?: CompactionSettings): ResolvedCompactionSettings {
	const raw = settings as Record<string, unknown> | undefined;
	return {
		enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
		reserveTokens: finiteNumber(raw?.reserveTokens, DEFAULTS.reserveTokens),
		keepRecentTokens: finiteNumber(raw?.keepRecentTokens, DEFAULTS.keepRecentTokens),
		speculativeEnabled:
			typeof raw?.speculativeEnabled === "boolean" ? raw.speculativeEnabled : DEFAULTS.speculativeEnabled,
		speculativeFraction: finiteNumber(raw?.speculativeFraction, DEFAULTS.speculativeFraction),
		speculativeCooldownMs: finiteNumber(raw?.speculativeCooldownMs, DEFAULTS.speculativeCooldownMs),
		restorationEnabled:
			typeof raw?.restorationEnabled === "boolean" ? raw.restorationEnabled : DEFAULTS.restorationEnabled,
		restorationMaxItems: finiteNumber(raw?.restorationMaxItems, DEFAULTS.restorationMaxItems),
		restorationMaxTokensPerItem: finiteNumber(raw?.restorationMaxTokensPerItem, DEFAULTS.restorationMaxTokensPerItem),
		restorationMaxTotalTokens: finiteNumber(raw?.restorationMaxTotalTokens, DEFAULTS.restorationMaxTotalTokens),
		restorationContextRatio: finiteNumber(raw?.restorationContextRatio, DEFAULTS.restorationContextRatio),
		idleCompactionEnabled:
			typeof raw?.idleCompactionEnabled === "boolean" ? raw.idleCompactionEnabled : DEFAULTS.idleCompactionEnabled,
		graceBandEnabled: typeof raw?.graceBandEnabled === "boolean" ? raw.graceBandEnabled : DEFAULTS.graceBandEnabled,
		toolAdmissionEnabled:
			typeof raw?.toolAdmissionEnabled === "boolean" ? raw.toolAdmissionEnabled : DEFAULTS.toolAdmissionEnabled,
		reminderEnabled: typeof raw?.reminderEnabled === "boolean" ? raw.reminderEnabled : DEFAULTS.reminderEnabled,
		reserveScalingEnabled:
			typeof raw?.reserveScalingEnabled === "boolean" ? raw.reserveScalingEnabled : DEFAULTS.reserveScalingEnabled,
		speculativeLeadTokens:
			typeof raw?.speculativeLeadTokens === "number" && Number.isFinite(raw.speculativeLeadTokens)
				? Math.max(0, raw.speculativeLeadTokens)
				: undefined,
	};
}
