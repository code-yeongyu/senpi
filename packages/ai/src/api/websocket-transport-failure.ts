/**
 * Turns a WebSocket runtime's `error` / `close` event pair into ONE failure
 * that names the cause.
 *
 * On an unclean disconnect Bun (and Node's undici client) fire an `error`
 * event that carries no message, followed by the `close` event that holds the
 * code and reason - `1006 Connection ended` for a dropped TCP session. Failing
 * on the first event reported a bare "WebSocket error" and threw that diagnosis
 * away (senpi#1628). A message-less error therefore waits for the close frame,
 * bounded by a short grace so a runtime that never sends one still fails.
 */

export const WEBSOCKET_ERROR_CLOSE_GRACE_MS = 250;
export const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

export class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The runtime's own message for an `error` event, or undefined when it sent none. */
export function extractWebSocketErrorMessage(event: unknown): Error | undefined {
	if (!event || typeof event !== "object") return undefined;
	const message = nonEmptyString((event as { message?: unknown }).message);
	if (message !== undefined) return new Error(message);
	const nested = (event as { error?: unknown }).error;
	if (nested instanceof Error && nested.message.length > 0) return nested;
	if (nested && typeof nested === "object") {
		const nestedMessage = nonEmptyString((nested as { message?: unknown }).message);
		if (nestedMessage !== undefined) return new Error(nestedMessage);
	}
	return undefined;
}

export function genericWebSocketError(): Error {
	return new Error("WebSocket error");
}

export function extractWebSocketCloseError(event: unknown): Error {
	if (!event || typeof event !== "object") return new Error("WebSocket closed");
	const code = (event as { code?: unknown }).code;
	const reason = nonEmptyString((event as { reason?: unknown }).reason);
	const wasClean = (event as { wasClean?: unknown }).wasClean;
	const codeText = typeof code === "number" ? ` ${code}` : "";
	const reasonText =
		reason !== undefined ? ` ${reason}` : code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE ? " message too big" : "";
	return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
		code: typeof code === "number" ? code : undefined,
		reason,
		wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
	});
}

export interface WebSocketTransportFailure {
	onError(event: unknown): void;
	onClose(event: unknown): void;
	dispose(): void;
}

/**
 * Reports at most one failure to `fail`. A message-bearing `error` reports at
 * once; a message-less one defers to the `close` that follows, or to the
 * generic error once the grace expires. `dispose` cancels a pending grace when
 * the caller settles the stream some other way (completion, abort, idle).
 */
export function createWebSocketTransportFailure(
	fail: (error: Error) => void,
	graceMs = WEBSOCKET_ERROR_CLOSE_GRACE_MS,
): WebSocketTransportFailure {
	let grace: ReturnType<typeof setTimeout> | undefined;
	let reported = false;

	const report = (error: Error): void => {
		if (reported) return;
		reported = true;
		dispose();
		fail(error);
	};
	const dispose = (): void => {
		if (grace === undefined) return;
		clearTimeout(grace);
		grace = undefined;
	};

	return {
		onError(event) {
			const error = extractWebSocketErrorMessage(event);
			if (error !== undefined) {
				report(error);
				return;
			}
			if (reported || grace !== undefined) return;
			grace = setTimeout(() => {
				grace = undefined;
				report(genericWebSocketError());
			}, graceMs);
		},
		onClose(event) {
			report(extractWebSocketCloseError(event));
		},
		dispose,
	};
}
