import type { SessionRetryFallbackProfile } from "./agent-session-runtime.ts";

/**
 * The fallback policy of a session whose model was chosen explicitly (omo#13243): that model answers
 * or the turn fails with its own error. No chain, so the shipped defaults never apply either.
 */
export const PINNED_MODEL_RETRY_FALLBACK: SessionRetryFallbackProfile = Object.freeze({
	modelFallback: false,
	fallbackChains: Object.freeze({}),
});

/**
 * The fallback policy a launch runs with when its opener named no policy of its own: pinned when it
 * named a model, otherwise none (the settings decide). An explicit policy, `modelFallback: true`
 * included, always wins.
 */
export function launchRetryFallback(launch: {
	readonly namedModel: boolean;
	readonly retryFallback: SessionRetryFallbackProfile | undefined;
}): SessionRetryFallbackProfile | undefined {
	if (launch.retryFallback !== undefined) return launch.retryFallback;
	return launch.namedModel ? PINNED_MODEL_RETRY_FALLBACK : undefined;
}
