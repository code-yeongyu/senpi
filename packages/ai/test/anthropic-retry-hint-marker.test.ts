import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://localhost:9999",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

/** Build an SSE body from a list of {event, data} pairs. */
function buildSse(events: Array<{ event: string; data: string }>): string {
	return events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
}

/** Build the Anthropic SDK's full error response body for a 429. */
function build429Body(opts?: { retryAfterMs?: number; retryDelay?: string }): string {
	const error: Record<string, unknown> = {
		type: "error",
		error: {
			type: "rate_limit_error",
			message: "All tokens rate limited",
		},
	};
	if (opts?.retryAfterMs !== undefined) {
		(error.error as Record<string, unknown>).retry_after_ms = opts.retryAfterMs;
	}
	if (opts?.retryDelay !== undefined) {
		(error.error as Record<string, unknown>).retryDelay = opts.retryDelay;
	}
	return JSON.stringify(error);
}

/** Create a Response for a non-streaming error (the SDK throws before streaming begins). */
function makeErrorResponse(status: number, body: string, headers?: Record<string, string>): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** Create a ReadableStream from a string. */
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("anthropic 429 retry-hint marker", () => {
	it("HTTP 429 with retry-after: 1258 -> stream error message ends with (retry-after-ms: 1258000)", async () => {
		const model = makeModel();
		const context = makeContext();
		const errorBody = build429Body();

		const fetchMock = vi.fn(async () => makeErrorResponse(429, errorBody, { "retry-after": "1258" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, {
			apiKey: "sk-test",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).toMatch(/\(retry-after-ms: 1258000\)$/);
	});

	it("SSE in-stream event:error body with rate_limit_error and no hint -> NO marker appended", async () => {
		const model = makeModel();
		const context = makeContext();

		// The Anthropic SDK first gets a 200 OK response, then the stream
		// contains an `event: error` with a rate_limit_error body.
		const sseBody = buildSse([
			{
				event: "error",
				data: JSON.stringify({
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "All tokens rate limited",
					},
				}),
			},
		]);

		const fetchMock = vi.fn(
			async () =>
				new Response(makeStream(sseBody), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, {
			apiKey: "sk-test",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).not.toMatch(/\(retry-after-ms: \d+\)$/);
	});

	it("SSE in-stream event:error body with retryDelay '45s' -> marker 45000", async () => {
		const model = makeModel();
		const context = makeContext();

		const sseBody = buildSse([
			{
				event: "error",
				data: JSON.stringify({
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "Rate limited",
						retryDelay: "45s",
					},
				}),
			},
		]);

		const fetchMock = vi.fn(
			async () =>
				new Response(makeStream(sseBody), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, {
			apiKey: "sk-test",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).toMatch(/\(retry-after-ms: 45000\)$/);
	});

	it("non-429 error (500) -> message byte-identical, no marker", async () => {
		const model = makeModel();
		const context = makeContext();
		const errorBody = JSON.stringify({
			type: "error",
			error: {
				type: "api_error",
				message: "Internal server error",
			},
		});

		const fetchMock = vi.fn(async () => makeErrorResponse(500, errorBody));
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, {
			apiKey: "sk-test",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).not.toMatch(/\(retry-after-ms: \d+\)$/);
	});

	it("malformed SSE error body (invalid JSON) -> does not throw, no marker", async () => {
		const model = makeModel();
		const context = makeContext();

		// SSE event: error with garbage data — must not throw, must not append marker
		const sseBody = "event: error\ndata: {{{not valid json}}}\n";

		const fetchMock = vi.fn(
			async () =>
				new Response(makeStream(sseBody), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, {
			apiKey: "sk-test",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.errorMessage).not.toMatch(/\(retry-after-ms: \d+\)$/);
	});
});
