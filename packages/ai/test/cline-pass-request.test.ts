import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { getModels } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

function getClinePassModel(id: string): Model<"openai-completions"> {
	const model = (getModels("cline-pass") as Model<"openai-completions">[]).find((candidate) => candidate.id === id);
	if (model?.api !== "openai-completions") throw new Error(`Expected ClinePass model ${id}`);
	return model;
}

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

type CapturedRequest = {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
};

async function captureRequest(modelId: string, options: Parameters<typeof streamSimple>[2]): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : undefined;
		const headers = new Headers(request?.headers ?? init?.headers);
		const rawBody = request ? await request.clone().text() : String(init?.body ?? "");
		captured = {
			url: request ? request.url : String(input),
			headers: Object.fromEntries(headers.entries()),
			body: JSON.parse(rawBody) as Record<string, unknown>,
		};
		return new Response("stream stopped by test", { status: 500 });
	});
	vi.stubGlobal("fetch", fetchMock);

	const result = streamSimple(getClinePassModel(modelId), context, options);
	await result.result();

	if (!captured) throw new Error("Expected the ClinePass request to be captured");
	return captured;
}

describe("ClinePass request contract", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts to the ClinePass chat completions endpoint with a bearer key and the full model id", async () => {
		const request = await captureRequest("cline-pass/kimi-k3", { apiKey: "cline-test-key" });

		expect(request.url).toBe("https://api.cline.bot/api/v1/chat/completions");
		expect(request.headers.authorization).toBe("Bearer cline-test-key");
		expect(request.body.model).toBe("cline-pass/kimi-k3");
		expect(request.body.stream).toBe(true);
	});

	it("sends thinking through the nested OpenRouter-style reasoning object", async () => {
		const request = await captureRequest("cline-pass/kimi-k3", {
			apiKey: "cline-test-key",
			reasoning: "high",
		});

		expect(request.body.reasoning).toEqual({ effort: "high" });
		expect(request.body.reasoning_effort).toBeUndefined();
		expect(request.body.thinking).toBeUndefined();
	});

	it("caps output with max_tokens rather than max_completion_tokens", async () => {
		const request = await captureRequest("cline-pass/kimi-k3", {
			apiKey: "cline-test-key",
			maxTokens: 1234,
		});

		expect(request.body.max_tokens).toBe(1234);
		expect(request.body.max_completion_tokens).toBeUndefined();
	});

	it("keeps the nested reasoning shape for the DeepSeek models it fronts", async () => {
		const request = await captureRequest("cline-pass/deepseek-v4-pro", {
			apiKey: "cline-test-key",
			reasoning: "high",
		});

		expect(request.body.reasoning).toEqual({ effort: "high" });
		expect(request.body.reasoning_effort).toBeUndefined();
	});
});
