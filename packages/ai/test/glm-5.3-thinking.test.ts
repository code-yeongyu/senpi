import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function glm53OnZai(): Model<"openai-completions"> {
	return {
		id: "glm-5.3",
		name: "GLM-5.3",
		api: "openai-completions",
		provider: "zai",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		compat: { thinkingFormat: "zai", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
	};
}

async function captureParams(
	model: Model<"openai-completions">,
	reasoning?: string,
): Promise<{ thinking?: { type: string }; reasoning_effort?: string }> {
	let payload: unknown;
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{
			apiKey: "test",
			reasoning: reasoning as never,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();
	return (payload ?? mockState.lastParams) as { thinking?: { type: string }; reasoning_effort?: string };
}

describe("GLM 5.3 openai-completions reasoning effort", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("maps low effort through the zai thinking-level map (not raw)", async () => {
		const params = await captureParams(glm53OnZai(), "low");
		expect(params.reasoning_effort).toBe("high");
	});

	it("maps medium effort through the zai thinking-level map (not raw)", async () => {
		const params = await captureParams(glm53OnZai(), "medium");
		expect(params.reasoning_effort).toBe("high");
	});

	it("keeps thinking enabled even when no reasoning effort is set", async () => {
		const params = await captureParams(glm53OnZai());
		expect(params.thinking?.type).toBe("enabled");
	});
});
