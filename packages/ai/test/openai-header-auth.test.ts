import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenAI-compatible static header auth", () => {
	it("sends x-api-key without synthesizing bearer auth for chat completions", async () => {
		let capturedHeaders: Headers | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedHeaders = new Headers(init?.headers);
			return completionsResponse();
		});

		const result = await streamOpenAICompletions(completionsModel(), normalizeContext(context), {
			headers: { "x-api-key": "header-key" },
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedHeaders?.get("x-api-key")).toBe("header-key");
		expect(capturedHeaders?.has("authorization")).toBe(false);
	});

	it("sends x-api-key without synthesizing bearer auth for Responses", async () => {
		let capturedHeaders: Headers | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedHeaders = new Headers(init?.headers);
			return responsesResponse();
		});

		const result = await streamOpenAIResponses(responsesModel(), normalizeContext(context), {
			headers: { "x-api-key": "header-key" },
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedHeaders?.get("x-api-key")).toBe("header-key");
		expect(capturedHeaders?.has("authorization")).toBe(false);
	});

	it("rejects metadata-only headers before issuing a request", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");

		const result = await streamOpenAICompletions(completionsModel(), normalizeContext(context), {
			headers: { "User-Agent": "senpi-test" },
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API key for provider");
		expect(fetch).not.toHaveBeenCalled();
	});
});

function completionsModel(): Model<"openai-completions"> {
	return {
		id: "header-model",
		name: "Header model",
		api: "openai-completions",
		provider: "header-provider",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function responsesModel(): Model<"openai-responses"> {
	return {
		...completionsModel(),
		api: "openai-responses",
	};
}

function completionsResponse(): Response {
	const chunk = {
		id: "chatcmpl-header-auth",
		object: "chat.completion.chunk",
		created: 0,
		model: "header-model",
		choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
	};
	const done = {
		...chunk,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function responsesResponse(): Response {
	const event = {
		type: "response.completed",
		response: {
			id: "resp_header_auth",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}
