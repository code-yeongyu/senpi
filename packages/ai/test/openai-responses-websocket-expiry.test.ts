import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CachedWebSocketConnection, scheduleSessionWebSocketExpiry } from "../src/api/openai-responses.ts";

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

class FakeWebSocket {
	readyState: number;
	closes: Array<{ code?: number; reason?: string }> = [];

	constructor(readyState = 1) {
		this.readyState = readyState;
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.closes.push({ code, reason });
	}

	send(): void {}

	addEventListener(_type: WebSocketEventType, _listener: WebSocketListener): void {}

	removeEventListener(_type: WebSocketEventType, _listener: WebSocketListener): void {}
}

describe("OpenAI Responses session websocket idle expiry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-arms the expiry when it fires while the socket is busy, then evicts once idle", () => {
		const socket = new FakeWebSocket(1);
		const entry: CachedWebSocketConnection = { socket, busy: true };
		scheduleSessionWebSocketExpiry("sess-busy-rearm", entry);

		// TTL fires mid-request: the entry must survive (in-flight) but the
		// expiry must keep checking instead of dying with the fired timer.
		vi.advanceTimersByTime(SESSION_WEBSOCKET_CACHE_TTL_MS + 1);
		expect(socket.closes).toHaveLength(0);

		entry.busy = false;
		vi.advanceTimersByTime(SESSION_WEBSOCKET_CACHE_TTL_MS + 1);
		expect(socket.closes).toEqual([{ code: 1000, reason: "idle_timeout" }]);
	});

	it("evicts a busy entry whose socket died, so a lost release cannot pin it", () => {
		const socket = new FakeWebSocket(3);
		const entry: CachedWebSocketConnection = { socket, busy: true };
		scheduleSessionWebSocketExpiry("sess-busy-dead", entry);

		vi.advanceTimersByTime(SESSION_WEBSOCKET_CACHE_TTL_MS + 1);
		expect(socket.closes).toEqual([{ code: 1000, reason: "idle_timeout_dead" }]);
	});

	it("closes and drops an idle entry at the TTL", () => {
		const socket = new FakeWebSocket(1);
		const entry: CachedWebSocketConnection = { socket, busy: false };
		scheduleSessionWebSocketExpiry("sess-idle", entry);

		vi.advanceTimersByTime(SESSION_WEBSOCKET_CACHE_TTL_MS + 1);
		expect(socket.closes).toEqual([{ code: 1000, reason: "idle_timeout" }]);
	});
});
