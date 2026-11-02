/**
 * Transport liveness for one provider request (senpi#4608).
 *
 * The loop's silence bounds count public assistant events. A provider that accepted the request and keeps its
 * connection alive - SSE `ping` events, `:` comment keep-alives a relay sends while the upstream model is still
 * thinking - emits none of those, so a slow first token used to be killed as if the connection were dead. Providers
 * report received bytes through `onTransportActivity`; a silence bound that fires within one bound of the last
 * byte is extended instead of ending the request, and keep-alives alone are bounded by their own budget.
 */

// The wording keeps "timed out" so the retryable-error classifier treats it like the other stream bounds.
export class StreamKeepAliveTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(
			`Provider stream sent only keep-alives and timed out after ${timeoutMs}ms (raise streamKeepAliveTimeoutMs: retry.provider.keepAliveTimeoutMs in senpi settings; 0 disables)`,
		);
		this.name = "StreamKeepAliveTimeoutError";
	}
}

export type SilenceDeadlineVerdict =
	| { kind: "expire" }
	| { kind: "extend"; delayMs: number }
	| { kind: "keep-alive-exhausted"; error: StreamKeepAliveTimeoutError };

export interface TransportLiveness {
	readonly noteActivity: () => void;
	contentArrived(): void;
	onSilenceDeadline(windowMs: number): SilenceDeadlineVerdict;
}

export function createTransportLiveness(keepAliveTimeoutMs: number | undefined): TransportLiveness {
	let lastActivityAt: number | undefined;
	let contentSilenceSince = Date.now();
	return {
		noteActivity: () => {
			lastActivityAt = Date.now();
		},
		contentArrived: () => {
			contentSilenceSince = Date.now();
		},
		onSilenceDeadline: (windowMs) => {
			const now = Date.now();
			if (lastActivityAt === undefined || now - lastActivityAt >= windowMs) return { kind: "expire" };
			const delayMs = windowMs - (now - lastActivityAt);
			if (keepAliveTimeoutMs === undefined) return { kind: "extend", delayMs };
			const keepAliveLeftMs = keepAliveTimeoutMs - (now - contentSilenceSince);
			if (keepAliveLeftMs <= 0) {
				return { kind: "keep-alive-exhausted", error: new StreamKeepAliveTimeoutError(keepAliveTimeoutMs) };
			}
			return { kind: "extend", delayMs: Math.max(1, Math.min(delayMs, keepAliveLeftMs)) };
		},
	};
}
