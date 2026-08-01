import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const FALLBACK_COOLDOWN_MS = 60_000;

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
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

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function completedSSE(): string {
	return `data: ${JSON.stringify({
		type: "response.completed",
		response: {
			status: "completed",
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				total_tokens: 8,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	})}\n\n`;
}

function completedWebSocketEvents(): unknown[] {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_recovered",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

function installTransportHarness(): { connections: () => number; fetches: () => number } {
	let connectionCount = 0;
	let fetchCount = 0;
	const encoder = new TextEncoder();

	class MockWebSocket {
		static readonly OPEN = 1;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
		private readonly shouldFail: boolean;

		constructor() {
			connectionCount++;
			this.shouldFail = connectionCount === 1;
			queueMicrotask(() => {
				if (this.shouldFail) {
					this.dispatch("error", { error: new Error("transient websocket failure") });
				} else {
					this.dispatch("open", {});
				}
			});
		}

		addEventListener(type: string, listener: (event: unknown) => void): void {
			const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
			listeners.add(listener);
			this.listeners.set(type, listeners);
		}

		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}

		send(): void {
			if (this.shouldFail) return;
			queueMicrotask(() => {
				for (const event of completedWebSocketEvents()) {
					this.dispatch("message", { data: JSON.stringify(event) });
				}
			});
		}

		close(): void {
			this.readyState = MockWebSocket.CLOSED;
			this.dispatch("close", { code: 1000, reason: "test cleanup" });
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			fetchCount++;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(completedSSE()));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}),
	);

	return {
		connections: () => connectionCount,
		fetches: () => fetchCount,
	};
}

async function runSession(sessionId: string): Promise<void> {
	await streamOpenAICodexResponses(model, context, {
		apiKey: mockToken(),
		sessionId,
		transport: "auto",
	}).result();
}

describe("OpenAI Codex WebSocket fallback recovery", () => {
	it("keeps immediate requests on SSE during the fallback cooldown", async () => {
		const transport = installTransportHarness();

		await runSession("fallback-cooldown");
		await runSession("fallback-cooldown");

		expect(transport.connections()).toBe(1);
		expect(transport.fetches()).toBe(2);
	});

	it("retries WebSocket after the fallback cooldown", async () => {
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const transport = installTransportHarness();

		await runSession("fallback-recovery");
		expect(transport.connections()).toBe(1);
		expect(transport.fetches()).toBe(1);

		await runSession("fallback-recovery");
		expect(transport.connections()).toBe(1);
		expect(transport.fetches()).toBe(2);

		now += FALLBACK_COOLDOWN_MS + 1;
		await runSession("fallback-recovery");

		expect(transport.connections()).toBe(2);
		expect(transport.fetches()).toBe(2);
	});

	it("recovers WebSocket immediately after production cleanup", async () => {
		const transport = installTransportHarness();

		await runSession("fallback-cleanup");
		expect(getOpenAICodexWebSocketDebugStats("fallback-cleanup")?.websocketFallbackActive).toBe(true);

		closeOpenAICodexWebSocketSessions("fallback-cleanup");
		await runSession("fallback-cleanup");

		expect(transport.connections()).toBe(2);
		expect(transport.fetches()).toBe(1);
		const stats = getOpenAICodexWebSocketDebugStats("fallback-cleanup");
		expect(stats?.websocketFallbackActive).not.toBe(true);
		expect(stats?.websocketFailures).toBe(0);
		expect(stats?.sseFallbacks).toBe(0);
	});
});
