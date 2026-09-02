import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	generateSessionTitle,
	humanizeProviderError,
	sessionTitleRetryPolicy,
} from "../src/core/session-title-generator.ts";

const TITLE_MODEL = {
	api: "openai-completions",
	provider: "openrouter",
	id: "z-ai/glm-5.3-flash",
	reasoning: true,
	baseUrl: "https://openrouter.ai/api/v1",
} as unknown as Model<Api>;

function fakeTitleStream(text: string): {
	streamFn: NonNullable<Parameters<typeof generateSessionTitle>[0]["streamFn"]>;
	capturedOptions: () => SimpleStreamOptions | undefined;
} {
	let captured: SimpleStreamOptions | undefined;
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "z-ai/glm-5.3-flash",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
	} as unknown as AssistantMessage;
	const streamFn = ((_model: unknown, _context: unknown, options: SimpleStreamOptions | undefined) => {
		captured = options;
		return { result: async () => message } as unknown as AssistantMessageEventStream;
	}) as NonNullable<Parameters<typeof generateSessionTitle>[0]["streamFn"]>;
	return { streamFn, capturedOptions: () => captured };
}

describe("generateSessionTitle", () => {
	it("requests low reasoning so reasoning-mandatory endpoints do not reject the title call", async () => {
		const { streamFn, capturedOptions } = fakeTitleStream("<title>Fix Login Bug</title>");
		const title = await generateSessionTitle({
			firstPrompt: "Fix the login bug in the auth service",
			model: TITLE_MODEL,
			auth: {},
			sessionId: "test-session",
			streamFn,
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		expect(title).toBe("Fix Login Bug");
		const options = capturedOptions();
		// Unset reasoning makes pi-ai send `reasoning: { effort: "none" }` on
		// OpenRouter, which reasoning-mandatory endpoints reject with HTTP 400.
		expect(options?.reasoning).toBe("low");
		expect(options?.maxTokens).toBe(1024);
	});
});

describe("sessionTitleRetryPolicy", () => {
	it("caps the cosmetic title retry below the full agent-turn budget", () => {
		expect(sessionTitleRetryPolicy({ enabled: true, maxRetries: 3, baseDelayMs: 2000 })).toEqual({
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 2000,
		});
	});

	it("keeps a smaller user budget instead of inflating it", () => {
		expect(sessionTitleRetryPolicy({ enabled: true, maxRetries: 0, baseDelayMs: 500 })).toEqual({
			enabled: true,
			maxRetries: 0,
			baseDelayMs: 500,
		});
	});

	it("caps a long user backoff so a title never stalls for minutes", () => {
		expect(sessionTitleRetryPolicy({ enabled: true, maxRetries: 5, baseDelayMs: 60_000 })).toEqual({
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 2000,
		});
	});

	it("honors a disabled retry policy", () => {
		expect(sessionTitleRetryPolicy({ enabled: false, maxRetries: 3, baseDelayMs: 2000 })).toEqual({
			enabled: false,
			maxRetries: 1,
			baseDelayMs: 2000,
		});
	});
});

describe("humanizeProviderError", () => {
	it("extracts message, type, and request id from an Anthropic SSE error body", () => {
		expect(
			humanizeProviderError(
				'{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CdRmGPa88udPD5fc8dt8U"}',
			),
		).toBe("Overloaded (overloaded_error, request req_011CdRmGPa88udPD5fc8dt8U)");
	});

	it("parses the `<prefix> (<status>): <body>` shape formatProviderError emits", () => {
		expect(humanizeProviderError('OpenAI (503): {"error":{"message":"Service unavailable"}}')).toBe(
			"Service unavailable (HTTP 503)",
		);
	});

	it("falls back to the HTTP status when the body carries no error type", () => {
		expect(humanizeProviderError('529: {"message":"Overloaded"}')).toBe("Overloaded (HTTP 529)");
	});

	it("keeps a string-valued error body instead of falling back to raw JSON", () => {
		expect(humanizeProviderError('503: {"error":"blocked by gateway WAF"}')).toBe(
			"blocked by gateway WAF (HTTP 503)",
		);
	});

	it("retains the HTTP status alongside the provider error type", () => {
		expect(humanizeProviderError('529: {"message":"Overloaded","type":"server_error"}')).toBe(
			"Overloaded (server_error, HTTP 529)",
		);
	});

	it("returns non-JSON messages unchanged", () => {
		expect(humanizeProviderError("title provider failed")).toBe("title provider failed");
	});

	it("returns unrecognized JSON unchanged", () => {
		expect(humanizeProviderError('{"details":"no message here"}')).toBe('{"details":"no message here"}');
	});
});
