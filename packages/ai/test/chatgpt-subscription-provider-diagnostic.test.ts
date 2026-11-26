import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#3771: every ChatGPT-subscription limit shape must reach the user as a classified
// providerDiagnostic (quota / rate_limit, with the reset time when the backend names one),
// and an unrecognized failure keeps the provider's own error type instead of "no code".
// Contract guarded: the ProviderDiagnostic the openai-codex-responses adapter mints.

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const NOW_MS = Date.UTC(2026, 9, 20, 3, 0, 0);
const RECORDED_STREAM = readFileSync(
	new URL("./fixtures/chatgpt-subscription-usage-limit-stream.sse", import.meta.url),
	"utf8",
);

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
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

async function failedTurn(response: () => Response): Promise<AssistantMessage> {
	vi.useFakeTimers({ toFake: ["Date"], now: NOW_MS });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			if (String(input) !== ENDPOINT) throw new Error(`Unexpected URL: ${String(input)}`);
			return response();
		}),
	);
	const context = normalizeContext({
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: NOW_MS }],
	});
	const result = await streamOpenAICodexResponses(makeModel(), context, {
		apiKey: mockToken(),
		transport: "sse",
		maxRetries: 0,
	}).result();
	expect(result.stopReason).toBe("error");
	return result;
}

function sse(...events: Record<string, unknown>[]): () => Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function http(status: number, body: Record<string, unknown>): () => Response {
	return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("chatgpt-subscription failures carry a classified providerDiagnostic (#3771)", () => {
	it("classifies the recorded in-stream usage-limit error as quota with its reset time", async () => {
		const result = await failedTurn(
			() => new Response(RECORDED_STREAM, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		expect(result.providerDiagnostic).toEqual({
			category: "quota",
			httpStatus: 429,
			code: "usage_limit_reached",
			evidence: "structured_code",
			resetsAt: 1_792_540_800_000,
		});
	});

	it("classifies an HTTP 429 usage-limit body as quota with its reset time", async () => {
		const result = await failedTurn(
			http(429, {
				error: {
					type: "usage_limit_reached",
					message: "The usage limit has been reached",
					plan_type: "plus",
					resets_at: 1_792_540_800,
				},
			}),
		);
		expect(result.providerDiagnostic).toEqual({
			category: "quota",
			httpStatus: 429,
			code: "usage_limit_reached",
			evidence: "structured_code",
			resetsAt: 1_792_540_800_000,
		});
	});

	it("classifies a response.failed usage limit and turns resets_in_seconds into a reset time", async () => {
		const result = await failedTurn(
			sse({
				type: "response.failed",
				response: {
					id: "resp_fixture",
					status: "failed",
					error: {
						code: "usage_limit_reached",
						message: "The usage limit has been reached",
						resets_in_seconds: 3600,
					},
				},
			}),
		);
		expect(result.providerDiagnostic).toEqual({
			category: "quota",
			code: "usage_limit_reached",
			evidence: "structured_code",
			resetsAt: NOW_MS + 3_600_000,
		});
	});

	it("classifies an HTTP 429 rate_limit_exceeded body as rate_limit", async () => {
		const result = await failedTurn(
			http(429, { error: { type: "rate_limit_exceeded", message: "Rate limit reached", resets_in_seconds: 30 } }),
		);
		expect(result.providerDiagnostic).toEqual({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_exceeded",
			evidence: "structured_code",
			resetsAt: NOW_MS + 30_000,
		});
	});

	it("keeps an unrecognized in-stream error type as the code of an unknown diagnostic", async () => {
		const result = await failedTurn(
			sse({ type: "error", error: { type: "invalid_prompt", message: "Your prompt was flagged" } }),
		);
		expect(result.providerDiagnostic).toEqual({
			category: "unknown",
			code: "invalid_prompt",
			evidence: "structured_code",
		});
	});

	it("drops an error type that is not a plain lowercase token instead of echoing it", async () => {
		const result = await failedTurn(sse({ type: "error", error: { type: "sk-Secret123", message: "boom" } }));
		expect(result.providerDiagnostic).toEqual({ category: "unknown", code: "error", evidence: "structured_code" });
	});
});
