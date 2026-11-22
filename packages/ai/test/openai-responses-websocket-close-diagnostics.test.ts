import { afterEach, describe, expect, it, vi } from "vitest";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#1628: same runtime fact as the Codex adapter - an unclean disconnect
// arrives as a message-less `error` event and the `close` that follows names
// the code and reason.

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
			setTimeout(() => onSend(this), 0);
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

const model = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<"openai-responses">;

const context = {
	systemPrompt: "You are a test assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
} satisfies Context;

function outputItemAdded(): string {
	return JSON.stringify({
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	});
}

const NO_CLOSE_BOUND_MS = 1_000;

async function runStream(): Promise<{ stopReason: string; errorMessage?: string }> {
	const options = { apiKey: "test-key", transport: "websocket" } satisfies OpenAIResponsesOptions;
	const result = await streamOpenAIResponses(model, normalizeContext(context), options).result();
	return { stopReason: result.stopReason, errorMessage: result.errorMessage };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("OpenAI Responses websocket close diagnostics", () => {
	it.each([
		{
			name: "nested provider error",
			event: {
				type: "error",
				error: { code: null, message: "Tool choice 'web_search' not found in 'tools' parameter." },
				status: 400,
			},
			expected: "Error Code 400: Tool choice 'web_search' not found in 'tools' parameter.",
		},
		{
			name: "top-level provider error",
			event: { type: "error", code: "invalid_prompt", message: "Bad request" },
			expected: "Error Code invalid_prompt: Bad request",
		},
	])("reports the $name", async ({ event, expected }) => {
		vi.useFakeTimers();
		installMockWebSocket((socket) => {
			socket.dispatch("message", { data: JSON.stringify(event) });
			socket.dispatch("close", { code: 1000, reason: "done" });
		});

		const resultPromise = runStream();
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(expected);
	});

	it("reports the close code and reason when the error event carries no message", async () => {
		vi.useFakeTimers();
		installMockWebSocket((socket) => {
			socket.dispatch("message", { data: outputItemAdded() });
			socket.dispatch("error", {});
			socket.dispatch("close", { code: 1006, reason: "Connection ended" });
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
			socket.dispatch("message", { data: outputItemAdded() });
			socket.dispatch("error", { message: "read ECONNRESET" });
			socket.dispatch("close", { code: 1006, reason: "Connection ended" });
		});

		const resultPromise = runStream();
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("read ECONNRESET");
	});

	it("still fails within a bound when no close event ever follows", async () => {
		vi.useFakeTimers();
		installMockWebSocket((socket) => {
			socket.dispatch("message", { data: outputItemAdded() });
			socket.dispatch("error", {});
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
