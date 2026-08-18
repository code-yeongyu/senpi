import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModels, streamSimple } from "../src/compat.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

interface OpenAIMockState {
	lastParams: unknown;
}

const mockState = vi.hoisted<OpenAIMockState>(() => ({
	lastParams: undefined,
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
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
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

function getCompletionModel(id: string): Model<"openai-completions"> {
	const model = getModels("xai").find((candidate) => candidate.id === id);
	if (model?.api !== "openai-completions") {
		throw new Error(`Expected xAI OpenAI Completions model: ${id}`);
	}
	return model as Model<"openai-completions">;
}

async function captureParams(
	model: Model<"openai-completions">,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<Record<string, unknown>> {
	let payload: unknown;
	const result = await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
		{
			apiKey: "xai-test-token",
			reasoning,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();

	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(payload ?? mockState.lastParams).toBeDefined();
	return (payload ?? mockState.lastParams) as Record<string, unknown>;
}

describe("xAI Chat Completions reasoning effort", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends xhigh reasoning effort for Grok 4.6", async () => {
		const params = await captureParams(getCompletionModel("grok-4.6"), "xhigh");
		expect(params.reasoning_effort).toBe("xhigh");
	});

	it("omits reasoning effort for fixed-reasoning Grok 4.20", async () => {
		const params = await captureParams(getCompletionModel("grok-4.20-0309-reasoning"), "high");
		expect(params).not.toHaveProperty("reasoning_effort");
	});

	it("omits reasoning effort for non-reasoning Grok 4.20", async () => {
		const params = await captureParams(getCompletionModel("grok-4.20-0309-non-reasoning"));
		expect(params).not.toHaveProperty("reasoning_effort");
	});
});
