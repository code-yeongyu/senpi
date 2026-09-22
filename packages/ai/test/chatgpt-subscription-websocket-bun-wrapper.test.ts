import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	closeChatGptSubscriptionWebSocketSessions,
	resetChatGptSubscriptionWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

type Listener = (event: unknown) => void;

interface RuntimeSocket {
	readyState: number;
	dispatch(type: string, event: unknown): void;
}

function installRuntimeWebSocket(): { readonly sockets: RuntimeSocket[]; connections(): number } {
	const sockets: RuntimeSocket[] = [];
	let responseId = 0;

	class RuntimeWebSocket implements RuntimeSocket {
		static OPEN = 1;
		readyState = RuntimeWebSocket.OPEN;
		private readonly listeners = new Map<string, Set<Listener>>();

		constructor() {
			sockets.push(this);
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
			if (this.readyState !== RuntimeWebSocket.OPEN) return;
			queueMicrotask(() =>
				this.dispatch("message", {
					data: JSON.stringify({
						type: "response.completed",
						response: {
							id: `resp_${++responseId}`,
							status: "completed",
							usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
						},
					}),
				}),
			);
		}

		close(): void {
			this.readyState = 3;
		}

		dispatch(type: string, event: unknown): void {
			if (type === "close") this.readyState = 3;
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}

	vi.stubGlobal("WebSocket", RuntimeWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("unexpected fetch", { status: 500 })),
	);
	return { sockets, connections: () => sockets.length };
}

function mockToken(accountId = "acc_bun"): string {
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

const context: Context = { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const originalBunVersion = process.versions.bun;

beforeAll(() => {
	// The proxy-aware wrapper is selected once per process from process.versions.bun,
	// so this file owns the Bun branch and never shares module state with Node-path suites.
	process.versions.bun = "1.4.2";
});

afterAll(() => {
	if (originalBunVersion === undefined) {
		delete process.versions.bun;
	} else {
		process.versions.bun = originalBunVersion;
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
	closeChatGptSubscriptionWebSocketSessions();
	resetChatGptSubscriptionWebSocketDebugStats();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("openai-codex websocket on the Bun proxy-aware wrapper", () => {
	it("does not reuse a parked websocket the server closed", async () => {
		vi.useFakeTimers();
		const runtime = installRuntimeWebSocket();
		const options = { apiKey: mockToken(), transport: "auto" as const, sessionId: "bun-parked", timeoutMs: 1_000 };

		const first = await streamOpenAICodexResponses(model, context, options).result();
		expect(first.stopReason).toBe("stop");
		expect(runtime.connections()).toBe(1);

		runtime.sockets[0]?.dispatch("close", { code: 1001, reason: "server idle", wasClean: true });

		const secondPromise = streamOpenAICodexResponses(model, context, options).result();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(options.timeoutMs);
		const second = await secondPromise;
		expect(runtime.connections()).toBe(2);
		expect(second.stopReason).toBe("stop");
	});

	it("does not reuse a parked websocket whose readyState is no longer open", async () => {
		vi.useFakeTimers();
		const runtime = installRuntimeWebSocket();
		const options = { apiKey: mockToken(), transport: "auto" as const, sessionId: "bun-stale", timeoutMs: 1_000 };

		const first = await streamOpenAICodexResponses(model, context, options).result();
		expect(first.stopReason).toBe("stop");

		const parked = runtime.sockets[0];
		if (parked) parked.readyState = 3;

		const secondPromise = streamOpenAICodexResponses(model, context, options).result();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(options.timeoutMs);
		const second = await secondPromise;
		expect(runtime.connections()).toBe(2);
		expect(second.stopReason).toBe("stop");
	});
});
