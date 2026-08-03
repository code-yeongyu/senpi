import type { FallbackChains } from "./chains.ts";

export interface ProviderRetrySettings {
	timeoutMs?: number;
	streamStartTimeoutMs?: number;
	streamRetryTimeoutMs?: number; // first-request liveness cap after a provider timeout; default: 30000, 0 disables
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface RetrySettings {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	provider?: ProviderRetrySettings;
	modelFallback?: boolean;
	fallbackChains?: Record<string, string[]>;
	fallbackRevertPolicy?: "cooldown-expiry" | "never";
	abortServerSideFallback?: boolean;
	hintedWaitCapMs?: number;
	probeBackMaxMs?: number;
}

export interface ResolvedRetryFallbackSettings {
	modelFallback: boolean;
	chains: FallbackChains;
	revertPolicy: "cooldown-expiry" | "never";
}

export const DEFAULT_FALLBACK_CHAINS: FallbackChains = {
	"anthropic/claude-fable-5": [
		"apitopia/kimi-k3-unlocked:max",
		"anthropic/claude-opus-5:xhigh",
		"anthropic/claude-opus-4-8:xhigh",
	],
};

function cloneDefaultFallbackChains(): Record<string, readonly string[]> {
	const chains: Record<string, readonly string[]> = {};
	for (const [key, entries] of Object.entries(DEFAULT_FALLBACK_CHAINS)) {
		chains[key] = [...entries];
	}
	return chains;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function resolveFallbackChains(value: unknown): FallbackChains {
	if (value === undefined) return cloneDefaultFallbackChains();
	if (!isPlainObject(value)) return cloneDefaultFallbackChains();

	const chains: Record<string, readonly string[]> = {};
	for (const [key, entries] of Object.entries(value)) {
		if (!isStringArray(entries)) return cloneDefaultFallbackChains();
		chains[key] = [...entries];
	}
	return chains;
}

export function resolveRetryFallbackSettings(settings: RetrySettings | undefined): ResolvedRetryFallbackSettings {
	return {
		modelFallback: typeof settings?.modelFallback === "boolean" ? settings.modelFallback : true,
		chains: resolveFallbackChains(settings?.fallbackChains),
		revertPolicy: settings?.fallbackRevertPolicy === "never" ? "never" : "cooldown-expiry",
	};
}

export function resolveAbortServerSideFallback(settings: RetrySettings | undefined): boolean {
	return typeof settings?.abortServerSideFallback === "boolean" ? settings.abortServerSideFallback : true;
}

export const DEFAULT_HINTED_WAIT_CAP_MS = 300_000;
export const DEFAULT_PROBE_BACK_MAX_MS = 3_600_000;

export interface ResolvedHintPolicySettings {
	hintedWaitCapMs: number;
	probeBackMaxMs: number;
}

export function resolveHintPolicySettings(settings: RetrySettings | undefined): ResolvedHintPolicySettings {
	const hintedWaitCapMs =
		typeof settings?.hintedWaitCapMs === "number" && settings.hintedWaitCapMs >= 0
			? settings.hintedWaitCapMs
			: DEFAULT_HINTED_WAIT_CAP_MS;
	const probeBackMaxMs =
		typeof settings?.probeBackMaxMs === "number" && settings.probeBackMaxMs >= 0
			? settings.probeBackMaxMs
			: DEFAULT_PROBE_BACK_MAX_MS;

	if (probeBackMaxMs <= hintedWaitCapMs) {
		return { hintedWaitCapMs: DEFAULT_HINTED_WAIT_CAP_MS, probeBackMaxMs: DEFAULT_PROBE_BACK_MAX_MS };
	}

	return { hintedWaitCapMs, probeBackMaxMs };
}
