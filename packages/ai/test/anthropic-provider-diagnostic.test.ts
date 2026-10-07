import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#2197: a failed Anthropic turn carries a bounded providerDiagnostic minted only
// from the SDK's HTTP error metadata or the explicit SSE `event: error` envelope.

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

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
};

function errorBody(type: string | undefined, message = "provider says no"): string {
	return JSON.stringify({ type: "error", error: { ...(type === undefined ? {} : { type }), message } });
}

function stubHttp(
	status: number,
	body: string,
	contentType = "application/json",
	extraHeaders: Record<string, string> = {},
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType, ...extraHeaders } })),
	);
}

function stubSse(lines: string[]): void {
	const encoder = new TextEncoder();
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		),
	);
}

async function run(options: Parameters<typeof streamAnthropic>[2] = {}): Promise<AssistantMessage> {
	return streamAnthropic(makeModel(), normalizeContext(context), {
		apiKey: "sk-test",
		maxRetries: 0,
		...options,
	}).result();
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("anthropic providerDiagnostic from HTTP errors", () => {
	it.each([
		[401, "authentication_error", "auth"],
		[429, "rate_limit_error", "rate_limit"],
		[400, "invalid_request_error", "invalid_request"],
		[529, "overloaded_error", "provider_unavailable"],
		[402, "billing_error", "unknown"],
	] as const)("%i %s classifies as %s from the structured code", async (status, code, category) => {
		stubHttp(status, errorBody(code));
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toEqual({ category, httpStatus: status, code, evidence: "structured_code" });
	});

	it("classifies a non-JSON 500 from the status alone", async () => {
		stubHttp(500, "upstream exploded", "text/plain");
		const result = await run();
		expect(result.providerDiagnostic).toEqual({
			category: "provider_unavailable",
			httpStatus: 500,
			evidence: "structured_status",
		});
	});

	it("does not decide a family from a bare 429 without a recognized code", async () => {
		stubHttp(429, JSON.stringify({ error: { message: "slow down" } }));
		const result = await run();
		expect(result.providerDiagnostic).toEqual({
			category: "unknown",
			httpStatus: 429,
			evidence: "structured_status",
		});
	});

	it("omits the diagnostic when the code contradicts the status", async () => {
		stubHttp(401, errorBody("rate_limit_error"));
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toBeUndefined();
	});

	it("never reads the message text: quota wording on a 429 without a code stays unknown", async () => {
		stubHttp(429, JSON.stringify({ error: { message: "insufficient_quota context_length_exceeded billing" } }));
		const result = await run();
		expect(result.providerDiagnostic?.category).toBe("unknown");
		expect(result.providerDiagnostic?.code).toBeUndefined();
	});

	it("keeps the diagnostic when the retry policy declines the provider's requested delay", async () => {
		stubHttp(429, errorBody("rate_limit_error"), "application/json", { "retry-after-ms": "1000" });
		const result = await run({ maxRetries: 1, maxRetryDelayMs: 10 });
		expect(result.errorMessage).toContain("Server requested 1s retry delay");
		expect(result.providerDiagnostic).toEqual({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_error",
			evidence: "structured_code",
		});
	});

	it("leaves errorMessage and the provider_retry_failure diagnostic in place", async () => {
		stubHttp(401, errorBody("authentication_error", "invalid x-api-key"));
		const result = await run();
		expect(result.errorMessage).toContain("invalid x-api-key");
		const retryFailures = (result.diagnostics ?? []).filter((d) => d.type === "provider_retry_failure");
		expect(retryFailures).toHaveLength(1);
		expect(retryFailures[0]?.details?.statusCode).toBe(401);
		expect(JSON.stringify(result.providerDiagnostic).length).toBeLessThanOrEqual(512);
	});
});

describe("anthropic providerDiagnostic from the SSE error envelope", () => {
	it("classifies an in-stream overloaded_error without an HTTP status", async () => {
		stubSse(["event: error", `data: ${errorBody("overloaded_error", "Overloaded")}`]);
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toEqual({
			category: "provider_unavailable",
			code: "overloaded_error",
			evidence: "structured_code",
		});
	});

	it("omits the diagnostic for an unparseable envelope", async () => {
		stubSse(["event: error", "data: overloaded, try later"]);
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toBeUndefined();
	});
});

describe("anthropic providerDiagnostic provenance", () => {
	it("ignores a status-shaped error thrown by a caller callback", async () => {
		const fetchMock = vi.fn(async () => new Response(errorBody("authentication_error"), { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		const forged = Object.assign(new Error("callback failed"), {
			status: 401,
			type: "authentication_error",
			error: { type: "error", error: { type: "authentication_error" } },
		});
		const result = await run({
			onPayload: () => {
				throw forged;
			},
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("callback failed");
		expect(result.providerDiagnostic).toBeUndefined();
	});

	it("does not label a caller abort", async () => {
		stubHttp(401, errorBody("authentication_error"));
		const controller = new AbortController();
		controller.abort();
		const result = await run({ signal: controller.signal });
		expect(result.stopReason).toBe("aborted");
		expect(result.providerDiagnostic).toBeUndefined();
	});
});
