import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeChatGptSubscriptionWebSocketSessions,
	resetChatGptSubscriptionWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import {
	formatWebSocketLivenessFailure,
	WEBSOCKET_LIVENESS_MAX_UNANSWERED_PINGS,
	WEBSOCKET_LIVENESS_PING_INTERVAL_MS,
	WEBSOCKET_LIVENESS_PONG_TIMEOUT_MS,
} from "../src/api/websocket-liveness.ts";
import type { Context, Model } from "../src/types.ts";

type Listener = (event: unknown) => void;

interface MockSocketBehavior {
	readonly ping?: "unanswered" | "answered";
	readonly exposeReadyState?: boolean;
	readonly onSend: (socket: MockSocketHandle, requestIndex: number) => void;
}

interface MockSocketHandle {
	dispatch(type: string, event: unknown): void;
	setReadyState(value: number): void;
}

interface MockSocketRuntime {
	readonly connections: number;
	readonly pings: number;
	readonly sockets: readonly MockSocketHandle[];
}

function installMockWebSocket(behavior: MockSocketBehavior): MockSocketRuntime {
	const runtime = { connections: 0, pings: 0, sockets: [] as MockSocketHandle[] };
	let requestIndex = 0;

	class MockWebSocket implements MockSocketHandle {
		private readonly listeners = new Map<string, Set<Listener>>();
		private closed = false;
		readyState?: number;

		constructor() {
			runtime.connections++;
			runtime.sockets.push(this);
			if (behavior.exposeReadyState !== false) this.readyState = 1;
			queueMicrotask(() => this.dispatch("open", {}));
		}

		addEventListener(type: string, listener: Listener): void {
			let listeners = this.listeners.get(type);
			if (!listeners) {
				listeners = new Set();
				this.listeners.set(type, listeners);
			}
			listeners.add(listener);
		}

		removeEventListener(type: string, listener: Listener): void {
			this.listeners.get(type)?.delete(listener);
		}

		send(): void {
			if (this.closed) return;
			behavior.onSend(this, requestIndex++);
		}

		close(): void {
			this.closed = true;
			this.setReadyState(3);
		}

		dispatch(type: string, event: unknown): void {
			if (type === "close") {
				this.closed = true;
				this.setReadyState(3);
			}
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}

		setReadyState(value: number): void {
			if (behavior.exposeReadyState !== false) this.readyState = value;
		}
	}

	if (behavior.ping !== undefined) {
		const mode = behavior.ping;
		Object.defineProperty(MockWebSocket.prototype, "ping", {
			value(this: MockWebSocket) {
				runtime.pings++;
				if (mode === "answered") queueMicrotask(() => this.dispatch("pong", { data: "liveness" }));
			},
		});
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("unexpected fetch", { status: 500 })),
	);
	return runtime;
}

function mockToken(accountId = "acc_liveness"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "chatgpt-subscription",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
};

function messageStarted(): string {
	return JSON.stringify({
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	});
}

function responseCompleted(responseId: string): string {
	return JSON.stringify({
		type: "response.completed",
		response: { id: responseId, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
	});
}

const IDLE_TIMEOUT_MS = 300_000;
const DEAD_AFTER_MS =
	WEBSOCKET_LIVENESS_PING_INTERVAL_MS + WEBSOCKET_LIVENESS_PONG_TIMEOUT_MS * WEBSOCKET_LIVENESS_MAX_UNANSWERED_PINGS;

afterEach(() => {
	vi.unstubAllGlobals();
	closeChatGptSubscriptionWebSocketSessions();
	resetChatGptSubscriptionWebSocketDebugStats();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("openai-codex websocket liveness", () => {
	it("declares a silent websocket dead after unanswered pings instead of waiting out the idle timeout", async () => {
		vi.useFakeTimers();
		const runtime = installMockWebSocket({
			ping: "unanswered",
			onSend: (socket) => queueMicrotask(() => socket.dispatch("message", { data: messageStarted() })),
		});

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			transport: "auto",
			timeoutMs: IDLE_TIMEOUT_MS,
		}).result();
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(WEBSOCKET_LIVENESS_PING_INTERVAL_MS - 1);
		expect(runtime.pings).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(runtime.pings).toBe(1);
		await vi.advanceTimersByTimeAsync(WEBSOCKET_LIVENESS_PONG_TIMEOUT_MS);
		expect(runtime.pings).toBe(2);
		await vi.advanceTimersByTimeAsync(WEBSOCKET_LIVENESS_PONG_TIMEOUT_MS);

		const result = await resultPromise;
		expect(DEAD_AFTER_MS).toBeLessThan(IDLE_TIMEOUT_MS);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(formatWebSocketLivenessFailure(DEAD_AFTER_MS, 2));
	});

	it("keeps waiting while pongs keep arriving on a silent stream", async () => {
		vi.useFakeTimers();
		const sockets: MockSocketHandle[] = [];
		const runtime = installMockWebSocket({
			ping: "answered",
			onSend: (socket) => {
				sockets.push(socket);
				queueMicrotask(() => socket.dispatch("message", { data: messageStarted() }));
			},
		});

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			transport: "auto",
			timeoutMs: IDLE_TIMEOUT_MS,
		}).result();
		await vi.advanceTimersByTimeAsync(0);

		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(DEAD_AFTER_MS * 3);
		expect(settled).toBe(false);
		expect(runtime.pings).toBeGreaterThanOrEqual(3);

		sockets[0]?.dispatch("message", { data: responseCompleted("resp_alive") });
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;
		expect(result.stopReason).toBe("stop");
	});

	it("leaves the idle timeout in charge when the runtime websocket has no ping API", async () => {
		vi.useFakeTimers();
		const idleTimeoutMs = 100_000;
		installMockWebSocket({
			onSend: (socket) => queueMicrotask(() => socket.dispatch("message", { data: messageStarted() })),
		});

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			transport: "auto",
			timeoutMs: idleTimeoutMs,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(idleTimeoutMs);

		const result = await resultPromise;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
	});

	it("opens a new connection after a parked websocket closes, even when readyState is unavailable", async () => {
		vi.useFakeTimers();
		const runtime = installMockWebSocket({
			exposeReadyState: false,
			onSend: (socket, requestIndex) =>
				queueMicrotask(() => socket.dispatch("message", { data: responseCompleted(`resp_${requestIndex}`) })),
		});
		const options = {
			apiKey: mockToken(),
			transport: "auto" as const,
			sessionId: "parked-session",
			timeoutMs: 1_000,
		};

		const first = await streamOpenAICodexResponses(model, context, options).result();
		expect(first.stopReason).toBe("stop");
		expect(runtime.connections).toBe(1);

		runtime.sockets[0]?.dispatch("close", { code: 1001, reason: "server idle", wasClean: true });

		const secondPromise = streamOpenAICodexResponses(model, context, options).result();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(options.timeoutMs);
		const second = await secondPromise;
		expect(runtime.connections).toBe(2);
		expect(second.stopReason).toBe("stop");
	});
});
