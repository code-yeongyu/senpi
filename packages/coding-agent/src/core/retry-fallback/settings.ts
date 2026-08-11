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

/**
 * Shipped defaults are declared as model families (bare ids, no provider prefix).
 * `canonicalizeFallbackChains` expands them against the live registry, so the
 * chain follows Fable 5 whichever provider serves it - the builtin Anthropic
 * provider, the Claude SDK OAuth extension, a gateway, or Bedrock.
 */
export const DEFAULT_FALLBACK_CHAINS: FallbackChains = {
	"claude-fable-5": ["k3:max", "claude-opus-5:xhigh", "claude-opus-4-8:xhigh"],
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

/**
 * User chains layer over the shipped defaults per key instead of replacing the
 * whole map. Configuring an unrelated model must not silently delete a default
 * chain: that left the defaulted model with no client chain at all, which in
 * turn disabled the server-fallback abort and handed model choice back to the
 * provider. A same-named key still replaces that default outright (never a
 * union), and an explicit empty array removes a default the user does not want -
 * as a tombstone honored at both bare-family and canonical-provider granularity.
 *
 * Cross-scope replacement (global vs project) stays wholesale and is handled by
 * `deepMergeSettings`; this only resolves defaults against the merged result.
 */
function resolveFallbackChains(value: unknown): FallbackChains {
	if (value === undefined) return cloneDefaultFallbackChains();
	if (!isPlainObject(value)) return cloneDefaultFallbackChains();

	const chains: Record<string, readonly string[]> = cloneDefaultFallbackChains();
	for (const [key, entries] of Object.entries(value)) {
		if (!isStringArray(entries)) return cloneDefaultFallbackChains();
		// An empty list stays in the map as a tombstone: canonicalization needs it to
		// suppress the expanded default for that family or provider variant, and
		// dropping it here would let the shipped default reappear after expansion.
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
