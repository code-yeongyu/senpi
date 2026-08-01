import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const SESSION_ID = "issue-589-session";

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

function decodeRequestBody(body: RequestInit["body"] | undefined): unknown {
	if (typeof body === "string") return JSON.parse(body);
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8"));
	}
	if (body instanceof ArrayBuffer) {
		return JSON.parse(Buffer.from(zstdDecompressSync(new Uint8Array(body))).toString("utf8"));
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectCacheAffinity(headers: Headers | undefined, body: unknown): void {
	expect(headers?.get("session-id")).toBe(SESSION_ID);
	expect(headers?.get("thread-id")).toBe(SESSION_ID);
	expect(headers?.get("x-client-request-id")).toBe(SESSION_ID);
	expect(isRecord(body) ? body.prompt_cache_key : undefined).toBe(SESSION_ID);
}

describe("OpenAI Codex cache affinity", () => {
	it("sends complete cache affinity over SSE", async () => {
		const encoder = new TextEncoder();
		let capturedHeaders: Headers | undefined;
		let capturedBody: unknown;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers instanceof Headers ? init.headers : undefined;
				capturedBody = decodeRequestBody(init?.body);
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

		await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			sessionId: SESSION_ID,
			transport: "sse",
		}).result();

		expectCacheAffinity(capturedHeaders, capturedBody);
	});

	it("sends complete cache affinity over WebSocket", async () => {
		let capturedHeaders: Record<string, string> | undefined;
		let capturedBody: unknown;

		class MockWebSocket {
			private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
				if (protocols && typeof protocols === "object" && !Array.isArray(protocols)) {
					capturedHeaders = protocols.headers;
				}
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				capturedBody = JSON.parse(data);
				const events = [
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
							id: "resp_issue_589",
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
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected fetch", { status: 500 })),
		);
		vi.stubGlobal("WebSocket", MockWebSocket);

		await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			sessionId: SESSION_ID,
			transport: "auto",
		}).result();

		expectCacheAffinity(capturedHeaders ? new Headers(capturedHeaders) : undefined, capturedBody);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("omits cache affinity when caching is disabled", async () => {
		const encoder = new TextEncoder();
		let capturedHeaders: Headers | undefined;
		let capturedBody: unknown;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL, init?: RequestInit) => {
				capturedHeaders = init?.headers instanceof Headers ? init.headers : undefined;
				capturedBody = decodeRequestBody(init?.body);
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

		await streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			cacheRetention: "none",
			sessionId: "one-off-summary",
			transport: "sse",
		}).result();

		expect(capturedHeaders?.has("session-id")).toBe(false);
		expect(capturedHeaders?.has("thread-id")).toBe(false);
		expect(capturedHeaders?.has("x-client-request-id")).toBe(false);
		expect(isRecord(capturedBody) ? capturedBody.prompt_cache_key : undefined).toBeUndefined();
	});
});
