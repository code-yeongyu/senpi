import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function mockToken(accountId = "acc_shared"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64url");
	return `aaa.${payload}.bbb`;
}

function makeModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "chatgpt-subscription",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function toolLoopContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{ role: "user", content: "List the files", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
				api: "openai-codex-responses",
				provider: "chatgpt-subscription",
				model: "gpt-5.1-codex",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "file-a\nfile-b" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

const SHARING_400_MESSAGE =
	"User subscription sharing currently supports only text, image, and file messages. Remove unsupported input items or use an API key instead.";
const SHARING_400 = JSON.stringify({
	error: {
		message: SHARING_400_MESSAGE,
	},
});

function makeSse(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("chatgpt-subscription shared-subscription item-limit 400 is surfaced typed (#6715)", () => {
	it("a route that rejects the tool items answers the typed error naming the route and remedy, once", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(SHARING_400, {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), normalizeContext(toolLoopContext()), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/User subscription sharing currently supports only/);
		expect(result.errorMessage).toMatch(/chatgpt-subscription/);
		expect(result.errorMessage).toMatch(/switch this session to a model/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("a child session replaying the same transcript gets the same typed error", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(SHARING_400, {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const inherited = normalizeContext(toolLoopContext());
		const result = await streamOpenAICodexResponses(makeModel(), inherited, {
			apiKey: mockToken("acc_child"),
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/chatgpt-subscription/);
		expect(result.errorMessage).toMatch(/switch this session to a model/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("the websocket error branch surfaces the typed route and remedy", async () => {
		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let set = this.listeners.get(type);
				if (!set) {
					set = new Set();
					this.listeners.set(type, set);
				}
				set.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(_data: string): void {
				const event = { type: "error", error: { message: SHARING_400_MESSAGE } };
				queueMicrotask(() => this.dispatch("message", { data: JSON.stringify(event) }));
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		const result = await streamOpenAICodexResponses(makeModel(), normalizeContext(toolLoopContext()), {
			apiKey: mockToken(),
			transport: "websocket",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/chatgpt-subscription/);
		expect(result.errorMessage).toMatch(/switch this session to a model/i);
	});

	it("the websocket response.failed branch surfaces the typed route and remedy", async () => {
		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let set = this.listeners.get(type);
				if (!set) {
					set = new Set();
					this.listeners.set(type, set);
				}
				set.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(_data: string): void {
				const event = { type: "response.failed", response: { error: { message: SHARING_400_MESSAGE } } };
				queueMicrotask(() => this.dispatch("message", { data: JSON.stringify(event) }));
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		const result = await streamOpenAICodexResponses(makeModel(), normalizeContext(toolLoopContext()), {
			apiKey: mockToken(),
			transport: "websocket",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/chatgpt-subscription/);
		expect(result.errorMessage).toMatch(/switch this session to a model/i);
	});

	it("a route that accepts the tool items sends them unchanged", async () => {
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "ok" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok" }],
				},
			},
			{ type: "response.completed", response: { id: "r", status: "completed", output: [] } },
		];
		const sseBody = events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
		let requestedUrl = "";
		const fetchMock = vi.fn(async (input: string | URL) => {
			requestedUrl = typeof input === "string" ? input : input.toString();
			return new Response(makeSse(sseBody), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), normalizeContext(toolLoopContext()), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requestedUrl).toContain("/codex/responses");
		expect(result.stopReason).not.toBe("error");
		expect(result.errorMessage ?? "").not.toMatch(/subscription sharing/i);
	});
});
