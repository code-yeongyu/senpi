import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

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

function makeErrorResponse(status: number, body: string, headers?: Record<string, string>): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function deepScanStrings(value: unknown, visit: (s: string) => void): void {
	if (typeof value === "string") {
		visit(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) deepScanStrings(item, visit);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			visit(key);
			deepScanStrings(child, visit);
		}
	}
}

const ALLOWED_DIAGNOSTIC_KEYS = ["kind", "statusCode", "providerCodes", "finishReason", "retryAfterMs", "shouldRetry"];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("anthropic provider_retry_failure diagnostic", () => {
	it("429 SDK failure emits exactly one diagnostic with statusCode 429 and retryAfterMs", async () => {
		const model = makeModel();
		const context = makeContext();
		const body = JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "All tokens rate limited" },
		});

		const fetchMock = vi.fn(async () => makeErrorResponse(429, body, { "retry-after": "2" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, { apiKey: "sk-test", maxRetries: 0 }).result();

		expect(result.stopReason).toBe("error");
		const diagnostics = result.diagnostics ?? [];
		const retryDiagnostics = diagnostics.filter((d) => d.type === "provider_retry_failure");
		expect(retryDiagnostics).toHaveLength(1);
		expect(retryDiagnostics[0]?.details?.statusCode).toBe(429);
		expect(retryDiagnostics[0]?.details?.retryAfterMs).toBe(2000);
	});

	it("errorMessage is CHARACTER-IDENTICAL to the existing retry-hint marker behaviour", async () => {
		const model = makeModel();
		const context = makeContext();
		const body = JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "All tokens rate limited" },
		});

		const fetchMock = vi.fn(async () => makeErrorResponse(429, body, { "retry-after": "1258" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, { apiKey: "sk-test", maxRetries: 0 }).result();

		expect(result.errorMessage).toMatch(/\(retry-after-ms: 1258000\)$/);
	});

	it("SSE event:error produces a diagnostic with statusCode absent", async () => {
		const model = makeModel();
		const context = makeContext();

		const sseBody = [
			"event: error",
			`data: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "All tokens rate limited" } })}`,
		].join("\n");

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody));
				controller.close();
			},
		});

		const fetchMock = vi.fn(
			async () =>
				new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, { apiKey: "sk-test", maxRetries: 0 }).result();

		expect(result.stopReason).toBe("error");
		const retryDiagnostics = (result.diagnostics ?? []).filter((d) => d.type === "provider_retry_failure");
		expect(retryDiagnostics).toHaveLength(1);
		expect("statusCode" in (retryDiagnostics[0]?.details ?? {})).toBe(false);
	});

	it("SECURITY: no Headers instance and no authorization string in any diagnostic", async () => {
		const model = makeModel();
		const context = makeContext();
		const body = JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "All tokens rate limited" },
		});

		const fetchMock = vi.fn(async () =>
			makeErrorResponse(429, body, {
				"retry-after": "5",
				authorization: "Bearer sk-ant-SECRET-DO-NOT-LEAK",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamAnthropic(model, context, { apiKey: "sk-test", maxRetries: 0 }).result();

		const retryDiagnostics = (result.diagnostics ?? []).filter((d) => d.type === "provider_retry_failure");
		expect(retryDiagnostics).toHaveLength(1);

		for (const diag of retryDiagnostics) {
			for (const key of Object.keys(diag.details ?? {})) {
				expect(ALLOWED_DIAGNOSTIC_KEYS).toContain(key);
			}
			const strings: string[] = [];
			deepScanStrings(diag.details, (s) => strings.push(s));
			expect(strings.some((s) => s.toLowerCase().includes("authorization"))).toBe(false);
			expect(JSON.stringify(diag.details).includes("sk-ant-SECRET")).toBe(false);
		}
	});
});
