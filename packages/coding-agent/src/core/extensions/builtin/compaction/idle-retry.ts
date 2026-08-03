/**
 * Retry policy for the idle compaction warm-up.
 *
 * The `agent_end` idle trigger only warms a speculative summary (#561 forbids
 * committing a durable boundary at idle). A transient summarization failure
 * used to leave a dead warm job for the whole idle period, forcing a fresh
 * blocking summarization onto the user's critical path at the next prompt.
 * While the session stays idle, a transient failure is retried a bounded
 * number of times with a fresh snapshot instead.
 */

export const MAX_IDLE_WARMUP_RETRIES = 2;
export const IDLE_WARMUP_RETRY_DELAY_MS = 15_000;

export interface IdleWarmupRetryDecision {
	readonly attempt: number;
	readonly transient: boolean;
	readonly isIdle: boolean;
	readonly breakerTripped: boolean;
	readonly stillOverThreshold: boolean;
}

export function shouldRetryIdleWarmup(decision: IdleWarmupRetryDecision): boolean {
	if (!decision.transient) return false;
	if (!decision.isIdle) return false;
	if (decision.breakerTripped) return false;
	if (!decision.stillOverThreshold) return false;
	return decision.attempt < MAX_IDLE_WARMUP_RETRIES;
}
