import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeChatGptSubscriptionWebSocketSessions,
	resetChatGptSubscriptionWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

// senpi#1628: the Bun WebSocket fires an `error` event with no message for an
// unclean disconnect and only the `close` event that follows carries the code
// and reason. Reporting "WebSocket error" from the first event threw that
// diagnosis away.

type Listener = (event: unknown) => void;

interface SocketHandle {
	dispatch(type: string, event: unknown): void;
}

function installMockWebSocket(onSend: (socket: SocketHandle) => void): void {
	class MockWebSocket implements SocketHandle {
		private readonly listeners = new Map<string, Set<Listener>>();
		readyState = 1;

		constructor() {
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
			onSend(this);
		}

		close(): void {
			this.readyState = 3;
		}

		dispatch(type: string, event: unknown): void {
			if (type === "close") this.readyState = 3;
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("unexpected fetch", { status: 500 })),
	);
}

function mockToken(accountId = "acc_close_diagnostics"): string {
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

const IDLE_TIMEOUT_MS = 300_000;
const NO_CLOSE_BOUND_MS = 1_000;

async function runStream(): Promise<{ stopReason: string; errorMessage?: string }> {
	const result = await streamOpenAICodexResponses(model, context, {
		apiKey: mockToken(),
		transport: "auto",
		timeoutMs: IDLE_TIMEOUT_MS,
	}).result();
	return { stopReason: result.stopReason, errorMessage: result.errorMessage };
}

afterEach(() => {
	vi.unstubAllGlobals();
	closeChatGptSubscriptionWebSocketSessions();
	resetChatGptSubscriptionWebSocketDebugStats();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("openai-codex websocket close diagnostics", () => {
	it("reports the close code and reason when the error event carries no message", async () => {
		vi.useFakeTimers();
		installMockWebSocket((socket) => {
			queueMicrotask(() => {
				socket.dispatch("message", { data: messageStarted() });
				socket.dispatch("error", {});
				socket.dispatch("close", { code: 1006, reason: "Connection ended", wasClean: false });
			});
		});

		const resultPromise = runStream();
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("WebSocket closed 1006 Connection ended");
	});

	it("keeps the runtime's own message when the error event carries one", async () => {
		vi.useFakeTimers();
		installMockWebSocket((socket) => {
			queueMicrotask(() => {
				socket.dispatch("message", { data: messageStarted() });
				socket.dispatch("error", { message: "read ECONNRESET" });
				socket.dispatch("close", { code: 1006, reason: "Connection ended", wasClean: false });
			});
		});

		const resultPromise = runStream();
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("read ECONNRESET");
	});

	it("still fails within the grace window when no close event ever follows", async () => {
		vi.useFakeTimers();
		installMockWebSocket((socket) => {
			queueMicrotask(() => {
				socket.dispatch("message", { data: messageStarted() });
				socket.dispatch("error", {});
			});
		});

		const resultPromise = runStream();
		await vi.advanceTimersByTimeAsync(0);
		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(NO_CLOSE_BOUND_MS);
		expect(settled).toBe(true);
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("WebSocket error");
	});
});
