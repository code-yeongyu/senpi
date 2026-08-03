import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function makeModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function makeStream(text: string): ReadableStream<Uint8Array> {
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

describe("codex 429 retry-hint marker", () => {
	it("HTTP 429 with retry-after: 1258 -> stream error message ends with (retry-after-ms: 1258000)", async () => {
		const token = mockToken();
		const errorBody = JSON.stringify({
			error: { code: "rate_limit_exceeded", message: "rate limited" },
		});

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(errorBody, {
				status: 429,
				headers: {
					"content-type": "application/json",
					"retry-after": "1258",
				},
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), makeContext(), {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).toMatch(/\(retry-after-ms: 1258000\)$/);
	});

	it("SSE in-stream error event with rate_limit_error and no hint -> NO marker appended", async () => {
		const token = mockToken();

		// The stream starts with 200 OK, then contains an error event
		const sseBody = `data: ${JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "All tokens rate limited",
			},
		})}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(makeStream(sseBody), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), makeContext(), {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).not.toMatch(/\(retry-after-ms: \d+\)$/);
	});

	it("SSE in-stream error event with retryDelay '45s' -> marker 45000", async () => {
		const token = mockToken();

		const sseBody = `data: ${JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "Rate limited",
				retryDelay: "45s",
			},
		})}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(makeStream(sseBody), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), makeContext(), {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).toMatch(/\(retry-after-ms: 45000\)$/);
	});

	it("non-429 error (500) -> message has no marker", async () => {
		const token = mockToken();
		const errorBody = JSON.stringify({
			error: { code: "server_error", message: "Internal server error" },
		});

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(errorBody, {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), makeContext(), {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).not.toMatch(/\(retry-after-ms: \d+\)$/);
	});

	it("malformed SSE error body (invalid JSON in error event) -> no marker, no throw", async () => {
		const token = mockToken();

		// Codex SSE: an error event with garbage payload
		const sseBody = `data: {{{not valid json}}}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(makeStream(sseBody), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), makeContext(), {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).not.toMatch(/\(retry-after-ms: \d+\)$/);
	});
});
