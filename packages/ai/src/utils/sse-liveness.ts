/**
 * Transport liveness for HTTP server-sent-event response bodies (senpi#4608).
 *
 * The agent loop bounds the time to the first content event (stream start, 300 s by default) and
 * the gap between content events (idle, 300 s), both sized so a slow-thinking model is not cut off.
 * Neither can tell that model apart from a connection that stopped delivering bytes, so a dead
 * transport after the response headers cost the whole bound. This bound sits below the event level:
 * every chunk read from the body, including `event: ping` and `:` comment keepalives, proves the
 * connection alive, so only a body that delivers no bytes at all for the bound is declared dead.
 * The WebSocket readers have the same verdict through ping/pong (websocket-liveness.ts, #1652).
 */

/**
 * Default no-bytes bound. Anthropic documents that a stream may include "any number of ping
 * events" without promising an interval, so the bound cannot assume a short keepalive period; 90 s
 * stays well under the 300 s start and idle bounds while leaving room for gateways that keep quiet.
 */
export const DEFAULT_SSE_LIVENESS_TIMEOUT_MS = 90_000;

export function formatSseLivenessFailure(timeoutMs: number): string {
	return `SSE transport liveness timeout after ${timeoutMs}ms (no bytes received)`;
}

export class SseTransportLivenessError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(formatSseLivenessFailure(timeoutMs));
		this.name = "SseTransportLivenessError";
		this.timeoutMs = timeoutMs;
	}
}

/** `undefined` takes the default; `0` (or any non-positive value) disables the bound. */
export function resolveSseLivenessTimeoutMs(configured: number | undefined): number | undefined {
	if (configured === undefined) return DEFAULT_SSE_LIVENESS_TIMEOUT_MS;
	if (!Number.isFinite(configured) || configured <= 0) return undefined;
	return Math.floor(configured);
}

/**
 * One `reader.read()` bounded by `timeoutMs` of silence. On expiry the body is cancelled with the
 * typed error, which releases the underlying connection, and that error is thrown.
 */
export async function readWithSseLiveness<T>(
	reader: ReadableStreamDefaultReader<T>,
	timeoutMs: number | undefined,
): Promise<ReadableStreamReadResult<T>> {
	if (timeoutMs === undefined) return reader.read();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new SseTransportLivenessError(timeoutMs)), timeoutMs);
	});
	try {
		return await Promise.race([reader.read(), deadline]);
	} catch (error) {
		if (error instanceof SseTransportLivenessError) {
			// The liveness verdict is the failure the caller needs; a body that also fails to cancel
			// (already errored or closed) has nothing left to release, so that rejection is not reported.
			await reader.cancel(error).catch(() => undefined);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
