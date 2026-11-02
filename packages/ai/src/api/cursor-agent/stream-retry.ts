export type CursorStreamRetryCause = "stall" | "transport" | "clean-end";

export class CursorRetryableStreamError extends Error {
	readonly retryCause: CursorStreamRetryCause;

	constructor(message: string, retryCause: CursorStreamRetryCause, options?: ErrorOptions) {
		super(message, options);
		this.name = "CursorRetryableStreamError";
		this.retryCause = retryCause;
	}
}

export function isCursorRetryableStreamError(error: unknown): error is CursorRetryableStreamError {
	return error instanceof CursorRetryableStreamError;
}

export function cursorStreamRetryDelayMs(options: {
	attempt: number;
	baseDelayMs?: number;
	fixedDelayMs?: number;
	random?: () => number;
}): number {
	if (options.fixedDelayMs !== undefined) return Math.max(0, options.fixedDelayMs);
	const baseDelayMs = options.baseDelayMs ?? 1000;
	const backoffMs = Math.min(baseDelayMs * 2 ** options.attempt, 60_000);
	const jitter = Math.floor(backoffMs * 0.2 * (options.random ?? Math.random)());
	return backoffMs + jitter;
}

export function shouldRetryCursorStream(options: {
	error: unknown;
	retries: number;
	maxRetries: number;
	sawTurnEnded: boolean;
	aborted: boolean;
}): boolean {
	return (
		!options.sawTurnEnded &&
		!options.aborted &&
		options.retries < options.maxRetries &&
		isCursorRetryableStreamError(options.error)
	);
}

export async function waitForCursorStreamRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0 || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
