import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Context, FetchFunction, Model } from "../src/types.ts";

// senpi#2197: OpenAI-compatible failures carry a providerDiagnostic minted from the SDK
// error's structured status and `error.code`, never from the message text.

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://upstream.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function httpError(
	status: number,
	error: Record<string, unknown>,
	extraHeaders: Record<string, string> = {},
): FetchFunction {
	return vi.fn<FetchFunction>(
		async () =>
			new Response(JSON.stringify({ error }), {
				status,
				headers: { "content-type": "application/json", ...extraHeaders },
			}),
	);
}

function sse(frames: string[]): FetchFunction {
	const encoder = new TextEncoder();
	return vi.fn<FetchFunction>(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
	);
}

async function run(
	fetch: FetchFunction,
	retry: { maxRetries: number; maxRetryDelayMs?: number } = { maxRetries: 0 },
): Promise<AssistantMessage> {
	return streamOpenAICompletions(model, context, { apiKey: "test-key", fetch, ...retry }).result();
}

describe("openai-completions providerDiagnostic", () => {
	it.each([
		[429, "insufficient_quota", "insufficient_quota", "quota"],
		[400, "invalid_request_error", "context_length_exceeded", "context_limit"],
		[401, "invalid_request_error", "invalid_api_key", "auth"],
		[429, "requests", "rate_limit_exceeded", "rate_limit"],
	] as const)("%i code %s/%s classifies as %s", async (status, type, code, category) => {
		const result = await run(httpError(status, { message: "provider says no", type, code }));
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toEqual({ category, httpStatus: status, code, evidence: "structured_code" });
	});

	it("discards an unrecognized code and classifies from the status", async () => {
		const result = await run(httpError(402, { message: "pay up", code: "payment_required_custom" }));
		expect(result.providerDiagnostic).toEqual({
			category: "unknown",
			httpStatus: 402,
			evidence: "structured_status",
		});
	});

	it("classifies a 503 without a code as provider_unavailable", async () => {
		const result = await run(httpError(503, { message: "upstream unavailable" }));
		expect(result.providerDiagnostic).toEqual({
			category: "provider_unavailable",
			httpStatus: 503,
			evidence: "structured_status",
		});
	});

	it("omits the diagnostic when the code contradicts the status", async () => {
		const result = await run(httpError(500, { message: "odd", code: "invalid_api_key" }));
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toBeUndefined();
	});

	it("classifies an in-stream error chunk from its code without an HTTP status", async () => {
		const result = await run(
			sse([JSON.stringify({ error: { message: "slow down", type: "requests", code: "rate_limit_exceeded" } })]),
		);
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toEqual({
			category: "rate_limit",
			code: "rate_limit_exceeded",
			evidence: "structured_code",
		});
	});

	it("keeps the diagnostic when the retry policy declines the provider's requested delay", async () => {
		const result = await run(
			httpError(429, { message: "slow down", code: "rate_limit_exceeded" }, { "retry-after-ms": "1000" }),
			{ maxRetries: 1, maxRetryDelayMs: 10 },
		);
		expect(result.errorMessage).toContain("Server requested 1s retry delay");
		expect(result.providerDiagnostic).toEqual({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_exceeded",
			evidence: "structured_code",
		});
	});

	it("keeps the existing errorMessage", async () => {
		const result = await run(
			httpError(429, { message: "You exceeded your current quota", code: "insufficient_quota" }),
		);
		expect(result.errorMessage).toContain("You exceeded your current quota");
	});
});
