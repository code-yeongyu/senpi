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
				stopReason: "toolCalls",
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

function plainContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("chatgpt-subscription shared-subscription tool items are refused pre-flight (#6715)", () => {
	it("a tool round-trip on a chatgpt-subscription model refuses with the typed error before any request", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("fetch must not be called for a refused request");
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), normalizeContext(toolLoopContext()), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/subscription sharing/i);
		expect(result.errorMessage).toMatch(/function_call/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a child session replaying the same transcript on the same route hits the same refusal", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("fetch must not be called for a refused request");
		});
		vi.stubGlobal("fetch", fetchMock);

		const inherited = normalizeContext(toolLoopContext());
		const result = await streamOpenAICodexResponses(makeModel(), inherited, {
			apiKey: mockToken("acc_child"),
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/subscription sharing/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a text-only conversation on the same model still builds a request", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamOpenAICodexResponses(makeModel(), normalizeContext(plainContext()), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(fetchMock).toHaveBeenCalled();
		expect(result.stopReason).not.toMatch(/subscription sharing/i);
	});
});
