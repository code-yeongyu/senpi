import type { RetryBackoffPolicy } from "./types.ts";

/**
 * Pure per-attempt retry delay for a stage's backoff policy.
 *
 * The exponential base is `baseDelayMs * growthFactor ** (retryNumber - 1)`
 * with `retryNumber` 1-based. The per-attempt cap is applied to that base
 * BEFORE jitter (`null` = no cap, `0` = literal zero cap), then the jitter
 * mode scales the capped value by the injected `random` sample in `[0, 1)`:
 * `none` returns the capped delay, `additive` grows it by up to `ratio`,
 * `subtractive` shrinks it by up to `ratio`. No `Math.random` here — callers
 * inject the sample so the schedule stays deterministic and testable.
 */
export function retryBackoffDelayMs(policy: RetryBackoffPolicy, retryNumber: number, random: number): number {
	const exponential = policy.baseDelayMs * policy.growthFactor ** (retryNumber - 1);
	const capped = policy.perAttemptCapMs === null ? exponential : Math.min(exponential, policy.perAttemptCapMs);
	switch (policy.jitter.mode) {
		case "none":
			return capped;
		case "additive":
			return capped + random * policy.jitter.ratio * capped;
		case "subtractive":
			return capped - random * policy.jitter.ratio * capped;
	}
}
