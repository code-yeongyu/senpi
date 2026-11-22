/**
 * The wait an agent-level auto-retry sleeps through, published on `session_status` and `list_sessions` so a
 * supervisor can tell "waiting on a provider until T" from work (senpi#7025). It exists only between an
 * `auto_retry_start` and the retried request's `agent_start` (or the retry's end).
 */
export interface RetryWait {
	readonly kind: "rate_limit" | "retry";
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly delayMs: number;
	readonly until: string;
	readonly error?: string;
}

const ERROR_CHARS = 200;
// The same 429-class markers the retry tier routing reads, plus usage and quota limits.
const RATE_LIMITED =
	/rate.?limit|usage.?limit|quota|too many requests|resource.?exhausted|(?:^|\b(?:HTTP\/1\.[01]|HTTP|status(?: code)?|error|code)\s+)429\b/i;

type RetryWaitEvent =
	| {
			readonly type: "auto_retry_start";
			readonly attempt: number;
			readonly maxAttempts: number;
			readonly delayMs: number;
			readonly errorMessage: string;
	  }
	| { readonly type: string };

export function nextRetryWait(
	previous: RetryWait | undefined,
	event: RetryWaitEvent,
	now: number,
): RetryWait | undefined {
	if ("errorMessage" in event && event.type === "auto_retry_start") {
		const error = event.errorMessage.slice(0, ERROR_CHARS);
		return {
			kind: RATE_LIMITED.test(event.errorMessage) ? "rate_limit" : "retry",
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			until: new Date(now + event.delayMs).toISOString(),
			...(error === "" ? {} : { error }),
		};
	}
	if (event.type === "agent_start" || event.type === "auto_retry_end") return undefined;
	return previous;
}

/**
 * The wait as a listing publishes it: the typed kind and its timing, never the provider's error text, which
 * stays on `get_state` and on `session_status`.
 */
export function redactedRetryWait(wait: RetryWait): RetryWait {
	return {
		kind: wait.kind,
		attempt: wait.attempt,
		maxAttempts: wait.maxAttempts,
		delayMs: wait.delayMs,
		until: wait.until,
	};
}
