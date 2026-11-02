import { retryBackoffDelayMs } from "./backoff.ts";
import type { RetryFailure, RetryStagePolicy } from "./types.ts";

/**
 * One planned retry decision: how long to wait before the next attempt, or
 * that a server hint asked for more than the profile's ceiling allows.
 *
 * - `wait` — sleep `delayMs` and retry.
 * - `over-ceiling` — the server-requested wait strictly exceeded the stage's
 *   `ceiling.maxDelayMs`; the caller turns this into an error-with-marker
 *   (profiles only declare `error-with-marker`, so no branch is needed here).
 * - `tiered` — see the tiered-stage contract below.
 */
export type RetryPlanResult =
	| { readonly kind: "wait"; readonly delayMs: number }
	| { readonly kind: "over-ceiling"; readonly requestedMs: number }
	| { readonly kind: "tiered"; readonly tier: string; readonly delayMs: number };

/**
 * Combine a stage's backoff schedule with its server-hint policy into one
 * retry delay decision.
 *
 * The computed backoff `retryBackoffDelayMs(stage.backoff, retryNumber,
 * random)` is the default. In `override` mode a positive `failure.retryAfterMs`
 * replaces that delay entirely — even when the hint is shorter — while zero,
 * negative, or absent hints fall back to the computed backoff unless the stage
 * opts into `acceptZero`. A hint strictly above `ceiling.maxDelayMs` surfaces
 * as `over-ceiling` instead of being clamped; a `null` ceiling makes that
 * unreachable, so any positive hint is honoured verbatim.
 *
 * Tiered-stage contract: this planner does NOT decide tiers. For a `tiered`
 * stage it merely reports whether a hint was present — `{ kind: "tiered",
 * tier: "delegated", delayMs: computed }` when `failure.retryAfterMs` exists,
 * plain `wait` with the computed backoff otherwise. The ACTUAL tier decision
 * (tier label, degraded budget, per-tier delay) stays in coding-agent's
 * existing hint-policy module
 * (`packages/coding-agent/src/core/retry-fallback/hint-policy.ts`), injected
 * into the profile as `RetryTieredHintStrategy`; packages must not import
 * across, so the label here is the fixed sentinel `"delegated"`.
 */
export function planRetryDelay(
	stage: RetryStagePolicy,
	failure: RetryFailure,
	retryNumber: number,
	random: number,
): RetryPlanResult {
	const computed = retryBackoffDelayMs(stage.backoff, retryNumber, random);
	const hint = failure.retryAfterMs;

	if (stage.serverHint.mode === "tiered") {
		return hint === undefined
			? { kind: "wait", delayMs: computed }
			: { kind: "tiered", tier: "delegated", delayMs: computed };
	}

	if (hint !== undefined && (hint > 0 || (hint === 0 && stage.serverHint.acceptZero))) {
		const { maxDelayMs } = stage.serverHint.ceiling;
		if (maxDelayMs !== null && hint > maxDelayMs) {
			return { kind: "over-ceiling", requestedMs: hint };
		}
		return { kind: "wait", delayMs: hint };
	}

	return { kind: "wait", delayMs: computed };
}
