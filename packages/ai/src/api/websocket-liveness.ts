/**
 * Ping/pong liveness for provider WebSocket streams.
 *
 * Without it a stream is judged dead only by the caller's idle budget (five
 * minutes by default), so a half-open connection - the network dropped without
 * a close frame - costs that whole budget before the retry that fixes it. The
 * monitor pings once the connection has been silent for `pingIntervalMs` and
 * reports the connection dead after `maxUnansweredPings` consecutive pings draw
 * no frame of any kind. Runtimes whose WebSocket has no `ping()` (Node's
 * built-in client) get an inert monitor, so their behavior is unchanged.
 */

export const WEBSOCKET_LIVENESS_PING_INTERVAL_MS = 30_000;
export const WEBSOCKET_LIVENESS_PONG_TIMEOUT_MS = 20_000;
export const WEBSOCKET_LIVENESS_MAX_UNANSWERED_PINGS = 2;

export interface WebSocketLivenessPolicy {
	readonly pingIntervalMs: number;
	readonly pongTimeoutMs: number;
	readonly maxUnansweredPings: number;
}

export const DEFAULT_WEBSOCKET_LIVENESS_POLICY: WebSocketLivenessPolicy = {
	pingIntervalMs: WEBSOCKET_LIVENESS_PING_INTERVAL_MS,
	pongTimeoutMs: WEBSOCKET_LIVENESS_PONG_TIMEOUT_MS,
	maxUnansweredPings: WEBSOCKET_LIVENESS_MAX_UNANSWERED_PINGS,
};

type LivenessEventType = "ping" | "pong";
type LivenessListener = (event: unknown) => void;

export interface LivenessCapableSocket {
	ping?(data?: string): void;
	addEventListener(type: LivenessEventType, listener: LivenessListener): void;
	removeEventListener(type: LivenessEventType, listener: LivenessListener): void;
}

export interface WebSocketLivenessMonitor {
	noteActivity(): void;
	stop(): void;
}

export function formatWebSocketLivenessFailure(silentMs: number, unansweredPings: number): string {
	return `WebSocket liveness timeout after ${silentMs}ms (${unansweredPings} pings unanswered)`;
}

export class WebSocketLivenessError extends Error {
	readonly silentMs: number;
	readonly unansweredPings: number;

	constructor(silentMs: number, unansweredPings: number, options?: { cause?: unknown }) {
		super(formatWebSocketLivenessFailure(silentMs, unansweredPings), options);
		this.name = "WebSocketLivenessError";
		this.silentMs = silentMs;
		this.unansweredPings = unansweredPings;
	}
}

const INERT_MONITOR: WebSocketLivenessMonitor = {
	noteActivity() {},
	stop() {},
};

export function supportsWebSocketLiveness(socket: LivenessCapableSocket): boolean {
	return typeof socket.ping === "function";
}

/**
 * Starts the heartbeat for one request on `socket`. Every inbound message must
 * be reported through `noteActivity()`; the monitor must be stopped when the
 * request settles. `onDead` fires at most once, after the monitor stopped itself.
 */
export function startWebSocketLiveness(
	socket: LivenessCapableSocket,
	onDead: (error: WebSocketLivenessError) => void,
	policy: WebSocketLivenessPolicy = DEFAULT_WEBSOCKET_LIVENESS_POLICY,
): WebSocketLivenessMonitor {
	const ping = socket.ping;
	if (typeof ping !== "function") return INERT_MONITOR;
	const sendPing = ping.bind(socket);

	let timer: ReturnType<typeof setTimeout> | undefined;
	let silentSince = Date.now();
	let unansweredPings = 0;
	let stopped = false;

	const onFrame: LivenessListener = () => noteActivity();
	socket.addEventListener("pong", onFrame);
	socket.addEventListener("ping", onFrame);

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		socket.removeEventListener("pong", onFrame);
		socket.removeEventListener("ping", onFrame);
	};

	const declareDead = (cause?: unknown): void => {
		const error = new WebSocketLivenessError(
			Date.now() - silentSince,
			unansweredPings,
			cause === undefined ? undefined : { cause },
		);
		stop();
		onDead(error);
	};

	const arm = (delayMs: number): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(onDeadline, delayMs);
	};

	const onDeadline = (): void => {
		timer = undefined;
		if (stopped) return;
		if (unansweredPings >= policy.maxUnansweredPings) {
			declareDead();
			return;
		}
		unansweredPings++;
		try {
			sendPing("liveness");
		} catch (cause) {
			// A ping that cannot be written is the same verdict as an unanswered one, reached sooner.
			declareDead(cause);
			return;
		}
		arm(policy.pongTimeoutMs);
	};

	const noteActivity = (): void => {
		if (stopped) return;
		silentSince = Date.now();
		unansweredPings = 0;
		arm(policy.pingIntervalMs);
	};

	arm(policy.pingIntervalMs);
	return { noteActivity, stop };
}
