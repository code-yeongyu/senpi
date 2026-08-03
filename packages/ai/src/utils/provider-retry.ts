import { appendRetryAfterMsMarker, extract429RetryAfterMs } from "./retry-hint.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DIGITALOCEAN_STREAM_FAILURE_MESSAGE = "Upstream error from DigitalOcean: stream failed";

export interface ProviderRetryDelayError extends Error {
	readonly retryAfterMs: number;
}

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error)) return false;
	if (error.message === DIGITALOCEAN_STREAM_FAILURE_MESSAGE) return true;
	if (!("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		const message = `Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`;
		const error: ProviderRetryDelayError = Object.assign(new Error(appendRetryAfterMsMarker(message, delayMs)), {
			retryAfterMs: delayMs,
		});
		throw error;
	}
	return delayMs;
}

function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const hintMs = extract429RetryAfterMs({
		status: 429,
		headers: error.headers,
		bodyText: "",
	});
	if (hintMs !== undefined) {
		return validateServerRetryDelayMs(hintMs, maxRetryDelayMs, error.message);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
		}
	}
}

interface ProviderStreamAttempt<TChunk, TMetadata> {
	stream: AsyncIterable<TChunk>;
	metadata: TMetadata;
}

async function* replayPrefetchedStream<TChunk>(
	first: IteratorResult<TChunk>,
	iterator: AsyncIterator<TChunk>,
): AsyncGenerator<TChunk> {
	if (first.done) return;
	let completed = false;
	let providerFailed = false;
	try {
		yield first.value;
		for (;;) {
			let next: IteratorResult<TChunk>;
			try {
				next = await iterator.next();
			} catch (error) {
				providerFailed = true;
				throw error;
			}
			if (next.done) {
				completed = true;
				return;
			}
			yield next.value;
		}
	} finally {
		if (!completed && !providerFailed) {
			await iterator.return?.();
		}
	}
}

export async function retryProviderStreamRequest<TChunk, TMetadata>(
	request: () => Promise<ProviderStreamAttempt<TChunk, TMetadata>>,
	options: ProviderRetryOptions = {},
): Promise<ProviderStreamAttempt<TChunk, TMetadata>> {
	return retryProviderRequest(async () => {
		const attempt = await request();
		const iterator = attempt.stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		return {
			stream: replayPrefetchedStream(first, iterator),
			metadata: attempt.metadata,
		};
	}, options);
}
