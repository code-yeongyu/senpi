/**
 * Pure value types for provider-declared retry policy profiles.
 *
 * A {@link RetryPolicyProfile} describes how one provider's requests are
 * retried at two independent stages — the provider/transport request and the
 * assistant turn — plus how the model-fallback chain interacts with the turn
 * budget. These types carry no behaviour; scheduling functions live in sibling
 * modules (`backoff.ts`, and later waves) so the contract stays pure data.
 */

/** Normalized failure category; the classifier union is exhaustive over this. */
export type RetryFailureKind =
	| "abort"
	| "connection"
	| "timeout"
	| "empty-response"
	| "quota-exhausted"
	| "http-status"
	| "image-format"
	| "provider"
	| "refusal"
	| "sensitive"
	| "unknown";

/**
 * Whitelisted facts about one provider failure, normalized at the API
 * boundary. Only these fields are ever retained: raw `Headers` objects,
 * authorization values, and response bodies are never carried here.
 */
export interface RetryFailure {
	/** API surface that captured the failure (e.g. "anthropic-messages"). */
	readonly origin: string;
	readonly kind: RetryFailureKind;
	/** Byte-identical to the error string today's regex classifier matches on. */
	readonly message: string;
	readonly statusCode?: number;
	/** Nested provider `error.type` / `error.code` strings when present. */
	readonly providerCodes?: readonly string[];
	readonly finishReason?: string;
	/** Parsed server-requested wait in ms when a hint exists. */
	readonly retryAfterMs?: number;
	/** Provider `x-should-retry` verdict when the transport exposed one. */
	readonly shouldRetry?: boolean;
}

/** Verdict of a stage classifier: how the retry loop may treat a failure. */
export type RetryClassification =
	| { readonly verdict: "transient" }
	| { readonly verdict: "rate-limited" }
	| { readonly verdict: "terminal" };

/** Classifies a normalized failure into a retry verdict. */
export type RetryClassifier = (failure: RetryFailure) => RetryClassification;

/**
 * Narrow server-hint extractor: returns a positive server-requested wait in
 * milliseconds, or undefined when the failure carries none. Profiles declare
 * their own; senpi's richer five-source precedence lives in `../retry-hint.ts`
 * and is not part of this contract.
 */
export type RetryHintExtractor = (failure: RetryFailure) => number | undefined;

/**
 * Jitter applied AFTER the per-attempt cap: `additive` grows the delay by up
 * to `ratio` (random * ratio * capped), `subtractive` shrinks it by the same
 * amount. `none` returns the capped delay unchanged.
 */
export type RetryJitterPolicy =
	| { readonly mode: "none" }
	| { readonly mode: "additive" | "subtractive"; readonly ratio: number };

export interface RetryBackoffPolicy {
	readonly baseDelayMs: number;
	readonly growthFactor: number;
	/**
	 * Per-attempt cap applied to `baseDelayMs * growthFactor ** (retryNumber - 1)`
	 * BEFORE jitter. `null` means no cap; `0` is a literal zero cap.
	 */
	readonly perAttemptCapMs: number | null;
	readonly jitter: RetryJitterPolicy;
}

/** Ceiling on a server-requested wait for `override`-mode hint policies. */
export interface RetryHintCeiling {
	/** `null` means no ceiling, so `over-ceiling` is unreachable. */
	readonly maxDelayMs: number | null;
	readonly onExceeded: "error-with-marker";
}

/** Tier verdict forwarded unchanged by the delay planner for tiered stages. */
export interface RetryTieredHintDecision {
	/** Tier label owned by the injected strategy (senpi's tiers live in coding-agent). */
	readonly tier: string;
	readonly delayMs: number;
}

/**
 * Tiered-hint strategy, injected from the coding-agent side. packages/ai must
 * not import packages/coding-agent, so the senpi-default profile receives its
 * tier engine (`classifyRateLimitedWait` / `nextInTurnDelayMs` /
 * `degradeWithoutFallback`) as a function value.
 */
export type RetryTieredHintStrategy = (
	failure: RetryFailure,
	retryNumber: number,
	backoff: RetryBackoffPolicy,
	now: number,
) => RetryTieredHintDecision;

/**
 * How a stage treats a server-requested wait. `override` replaces the computed
 * backoff with the hint (positive by default; `acceptZero` opts into zero);
 * `tiered` delegates the decision to the injected tier strategy.
 */
export type RetryServerHintPolicy =
	| {
			readonly mode: "override";
			readonly acceptZero: boolean;
			readonly ceiling: RetryHintCeiling;
	  }
	| {
			readonly mode: "tiered";
			readonly strategy: RetryTieredHintStrategy;
	  };

export interface RetryStagePolicy {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly backoff: RetryBackoffPolicy;
	readonly extractServerHint: RetryHintExtractor;
	readonly serverHint: RetryServerHintPolicy;
	readonly classify: RetryClassifier;
}

export interface RetryPolicyProfile {
	readonly id: string;
	readonly providerRequest: RetryStagePolicy;
	readonly turn: RetryStagePolicy;
	readonly fallback: {
		readonly terminal: "immediate-if-eligible";
		readonly transient: "after-turn-budget";
		readonly rateLimited: "tiered" | "after-turn-budget";
		readonly resetBudgetOnModelChange: true;
	};
}
