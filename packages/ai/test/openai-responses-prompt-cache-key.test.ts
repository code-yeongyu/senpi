import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface CapturedResponsesPayload {
	prompt_cache_key?: string;
}

const SESSION_ID = "session-2097";

async function capturePromptCacheKey(
	model: Model<"openai-responses">,
	options?: { cacheRetention?: "none" | "short" | "long"; sessionId?: string },
): Promise<string | undefined> {
	let capturedPayload: CapturedResponsesPayload | undefined;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);

	const stream = streamOpenAIResponses(
		model,
		normalizeContext({
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}),
		{
			apiKey: "test-key",
			sessionId: options?.sessionId ?? SESSION_ID,
			cacheRetention: options?.cacheRetention,
			onPayload: (payload) => {
				capturedPayload = payload as CapturedResponsesPayload;
			},
		},
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return capturedPayload?.prompt_cache_key;
}

describe("openai-responses prompt_cache_key", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// senpi#2097 and oh-my-openagent#10775: never partition a reusable prefix by session.
	it("sends a prefix prompt_cache_key for gpt-6-luna on api.openai.com", async () => {
		const key = await capturePromptCacheKey(getModel("openai", "gpt-6-luna"));
		expect(key).toEqual(expect.stringMatching(/^.{1,64}$/));
		expect(key).not.toBe(SESSION_ID);
	});

	it("sends a prefix prompt_cache_key for gpt-5.5 on api.openai.com", async () => {
		const key = await capturePromptCacheKey(getModel("openai", "gpt-5.5"));
		expect(key).toEqual(expect.stringMatching(/^.{1,64}$/));
		expect(key).not.toBe(SESSION_ID);
	});

	it("omits prompt_cache_key when cacheRetention is none for gpt-5.5", async () => {
		const key = await capturePromptCacheKey(getModel("openai", "gpt-5.5"), { cacheRetention: "none" });
		expect(key).toBeUndefined();
	});

	it("still sends prompt_cache_key for gpt-6-luna on a non-OpenAI proxy", async () => {
		const luna = getModel("openai", "gpt-6-luna");
		const proxy: Model<"openai-responses"> = {
			...luna,
			baseUrl: "https://proxy.example.com/v1",
		};
		const key = await capturePromptCacheKey(proxy);
		expect(key).toEqual(expect.stringMatching(/^.{1,64}$/));
		expect(key).not.toBe(SESSION_ID);
	});
});
