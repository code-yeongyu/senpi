import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",

	// Anthropic Console credit exhaustion: a 429 rate_limit_error whose details
	// carry error_code credits_required ("Usage credits are required for this
	// model."). The account is dead until the user buys credits or raises the
	// spend limit, so same-model retries can never recover it.
	"credits_required",
	"credits are required",

	// Request-shape rejections: the provider refused the payload we built, not the
	// work it describes. Gateways wrap these in whatever status they like — the
	// observed Apitopia/Kimi case arrives as `500 server_error: Invalid request:
	// tools.function.parameters.type is required and must be "object"` — so the
	// status text alone would classify a permanent failure as transient. The same
	// bytes are rejected on every attempt and on every fallback model, so retrying
	// can only burn the turn. Anchored on the `tools[...]`/`functions[...]` request
	// path so unrelated prose mentioning tools stays retryable.
	"invalid request: tools\\.",
	"invalid request: functions\\.",
	"tools\\.[^ ]*function\\.parameters",
	"tools\\.\\d+\\.function\\.parameters",
	"invalid tool schema",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	// Cloudflare 522 (Connection timed out): origin stopped responding; transient
	// like the other 5xx gateway statuses, surfaced as "Error: error code: 522".
	"522",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"upstream.?unavailable",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// Gateway/proxy-side rejection of the whole model request, e.g. "Error: The
	// model request was rejected. Check the request and try again." (observed in a
	// live session, 2026-08-11). Coupling the rejection sentence to its explicit
	// retry instruction keeps unrelated permission, request-shape, and content-
	// policy rejections terminal while the bounded retry policy absorbs this
	// transient wrapper wording.
	"the model request was rejected\\.\\s*check the request and try again\\.?",

	// Anthropic server-tool pairing rejections, e.g. "`web_search` tool use with id
	// `srvtoolu_...` was found without a corresponding `web_search_tool_result`
	// block". A turn closed before its deferred server tool could answer leaves
	// the unpairable half in history, and replaying it 400s every later request.
	// The Anthropic request builder repairs the replayed history, so a retry sends
	// a valid payload; keeping the class retryable is what lets retry and the model
	// fallback chain unwedge such a session instead of dead-ending it. The trailing
	// backtick keeps the pattern on Anthropic's pairing-error template.
	"was found without a corresponding `",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Injectable source used for Codex-style +/-10% backoff jitter. */
	random?: () => number;
}

export function retryDelayMs(baseDelayMs: number, attempt: number, random: () => number = Math.random): number {
	const scheduledDelayMs = baseDelayMs * 2 ** (attempt - 1);
	const sample = Math.min(1, Math.max(0, random()));
	return Math.round(scheduledDelayMs * (0.9 + sample * 0.2));
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a producer that signals failure by THROWING, with the same bounded
 * backoff, abort, and callback semantics as {@link retryAssistantCall}.
 *
 * `retryAssistantCall` is value-based: its producer reports failure by resolving
 * an `AssistantMessage` with `stopReason: "error"`. Callers that instead reject
 * (compaction summarization, and any other request pipeline that throws) need
 * the identical retry policy without reshaping their failures into assistant
 * messages first, so both live here and share one implementation of the delay,
 * abort, and callback contract.
 *
 * Behavior:
 * - A resolved value is returned immediately.
 * - A throw that `isRetryable` rejects is rethrown at once: deterministic
 *   failures never spend a retry.
 * - Otherwise the call is retried up to `policy.maxRetries` times with the same
 *   exponential backoff (`baseDelayMs * 2^(attempt-1)`), rethrowing the final
 *   error when the budget is exhausted.
 * - An abort during the backoff sleep stops the loop and rethrows; unlike the
 *   assistant-message path there is no aborted value to normalize to.
 *
 * When `policy` is undefined or disabled the producer runs exactly once and its
 * error propagates unchanged.
 */
export async function retryTransientCall<T>(
	produce: () => Promise<T>,
	isRetryable: (error: unknown) => boolean,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<T> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		try {
			const value = await produce();
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return value;
		} catch (error) {
			if (error instanceof RetrySleepAbortError) throw error;
			if (attempt >= maxAttempts || !isRetryable(error)) {
				if (lastRetry) {
					await callbacks?.onRetryFinished?.(false, lastRetry.attempt, errorMessageOf(error));
				}
				throw error;
			}

			attempt++;
			lastRetry = { attempt, errorMessage: errorMessageOf(error) };
			const delayMs = retryDelayMs(policy!.baseDelayMs, attempt, policy!.random);
			await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

			try {
				await sleep(delayMs, signal);
			} catch (sleepError) {
				await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
				throw sleepError instanceof RetrySleepAbortError ? error : sleepError;
			}
			await callbacks?.onRetryAttemptStart?.();
		}
	}
}

function errorMessageOf(error: unknown): string {
	if (error instanceof Error) return error.message || "Unknown error";
	return String(error) || "Unknown error";
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = retryDelayMs(policy!.baseDelayMs, attempt, policy!.random);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (
		message.stopReason !== "error" ||
		message.stopDetails?.type === "refusal" ||
		message.stopDetails?.type === "sensitive" ||
		!message.errorMessage
	) {
		return false;
	}
	return isRetryableErrorMessage(message.errorMessage);
}

/**
 * Matches the agent-loop stream watchdog failures ("Idle timeout waiting for
 * provider stream after <n>ms" and "Provider stream start timed out after
 * <n>ms"). These anchored shapes distinguish provider-stream stalls from
 * unrelated extension, command, or MCP timeout diagnostics.
 */
const PROVIDER_STREAM_STALL_ERROR_PATTERN =
	/^(?:Idle timeout waiting for provider stream after \d+ms|Provider stream start timed out after \d+ms)$/i;
const PROVIDER_TRANSPORT_TIMEOUT_ERROR_PATTERN = /^Request timed out\.?$/i;

export function isProviderStreamStallError(message: AssistantMessage): boolean {
	return message.stopReason === "error" && PROVIDER_STREAM_STALL_ERROR_PATTERN.test(message.errorMessage ?? "");
}

/**
 * Classifies timeout failures that originate from the provider stream or its
 * transport. Transport timeouts may arrive as `aborted`; stream watchdog
 * failures are ordinary error responses.
 */
export function isProviderTimeoutError(message: AssistantMessage): boolean {
	if (message.abortSource === "provider") return true;
	if (isProviderStreamStallError(message)) return true;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return false;
	return PROVIDER_TRANSPORT_TIMEOUT_ERROR_PATTERN.test(message.errorMessage ?? "");
}

/**
 * Classifies a raw error-message string with the same transient-vs-terminal
 * rules as {@link isRetryableAssistantError}, for callers that hold a thrown
 * `Error` instead of an `AssistantMessage` (e.g. compaction summarization
 * failures that must decide between degrading and surfacing loudly).
 */
export function isRetryableErrorMessage(errorMessage: string): boolean {
	return classifyErrorMessage(errorMessage) === "retryable";
}

/**
 * Tri-state form of {@link isRetryableErrorMessage}. The regexes only carry
 * three outcomes — a non-retryable match, a retryable match, or no match at
 * all — and callers that hold structured failure facts (status codes, provider
 * error codes) need to distinguish "the regexes say terminal" from "the
 * regexes say nothing" so they can consult the structured facts only in the
 * latter case. Non-retryable still outranks retryable, exactly as before.
 */
export function classifyErrorMessage(errorMessage: string): "non-retryable" | "retryable" | "unknown" {
	if (!errorMessage) return "unknown";
	if (NON_RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage)) return "non-retryable";
	if (RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage)) return "retryable";
	return "unknown";
}
