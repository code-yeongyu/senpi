import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model, Tool } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const sentFrames: string[] = [];
const constructedUrls: string[] = [];

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

class FakeWebSocket {
	private readonly listeners = new Map<WebSocketEventType, Set<WebSocketListener>>();
	readyState = 1;

	constructor(url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
		constructedUrls.push(url);
		queueMicrotask(() => this.emit("open", {}));
	}

	send(data: string): void {
		sentFrames.push(data);
		setTimeout(() => {
			this.emit("message", {
				data: JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_test",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				}),
			});
		}, 0);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", { code: 1000, reason: "done" });
	}

	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void {
		const listeners = this.listeners.get(type) ?? new Set<WebSocketListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	private emit(type: WebSocketEventType, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

function parseSentFrame(): Record<string, unknown> {
	const frame = sentFrames[0];
	if (!frame) {
		throw new Error("Expected a websocket frame to be sent");
	}
	const parsed = JSON.parse(frame);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Expected websocket frame to be an object");
	}
	return parsed;
}

describe("OpenAI Responses websocket transport", () => {
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		sentFrames.length = 0;
		constructedUrls.length = 0;
		globalThis.fetch = originalFetch;
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: originalWebSocket,
		});
	});

	it("sends parallel_tool_calls after onPayload mutates a websocket request", async () => {
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: FakeWebSocket,
		});

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
		const pingTool = {
			name: "ping",
			description: "Ping a target",
			parameters: Type.Object({ target: Type.String() }),
		} satisfies Tool;
		const context = {
			systemPrompt: "You are a test assistant.",
			messages: [{ role: "user", content: "Use the ping tool.", timestamp: Date.now() }],
			tools: [pingTool],
		} satisfies Context;
		const options = {
			apiKey: "test-key",
			transport: "websocket",
			onPayload: (payload) => {
				if (
					typeof payload === "object" &&
					payload !== null &&
					"tools" in payload &&
					!("parallel_tool_calls" in payload)
				) {
					return { ...payload, parallel_tool_calls: true };
				}
				return payload;
			},
		} satisfies OpenAIResponsesOptions;

		const stream = streamOpenAIResponses(model, normalizeContext(context), options);
		const result = await stream.result();
		const frame = parseSentFrame();

		expect(result.stopReason).toBe("stop");
		expect(frame.type).toBe("response.create");
		expect(frame.parallel_tool_calls).toBe(true);
	});

	it("uses SSE when the Responses websocket transport is disabled for a proxy", async () => {
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: FakeWebSocket,
		});

		globalThis.fetch = async () =>
			new Response(
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_test",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);

		const model = {
			id: "gpt-5.5",
			name: "GPT-5.5 via proxy",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsWebSocket: false },
		} satisfies Model<"openai-responses">;
		const context = {
			systemPrompt: "You are a test assistant.",
			messages: [{ role: "user", content: "Say pong.", timestamp: Date.now() }],
		} satisfies Context;

		const stream = streamOpenAIResponses(model, normalizeContext(context), {
			apiKey: "test-key",
			transport: "websocket",
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(constructedUrls).toEqual([]);
		expect(sentFrames).toEqual([]);
	});
});
