import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/images.ts";
import type { ImagesContext, ImagesModel } from "../src/types.ts";

type PromptUsage = {
	prompt_tokens: number;
	completion_tokens: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		cache_creation_tokens?: number;
	};
};

const mockState = vi.hoisted(() => ({
	usage: undefined as PromptUsage | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const response = {
						id: "img-cache",
						usage: mockState.usage ?? {
							prompt_tokens: 12,
							completion_tokens: 34,
							prompt_tokens_details: { cached_tokens: 0 },
						},
						choices: [{ message: { content: "", images: [] } }],
					};
					const promise = Promise.resolve(response) as Promise<typeof response> & {
						withResponse: () => Promise<{
							data: typeof response;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: response,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const model: ImagesModel<"openrouter-images"> = {
	type: "image",
	id: "google/gemini-3.1-flash-image-preview",
	name: "Gemini 3.1 Flash Image Preview",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	input: ["text", "image"],
	output: ["text", "image"],
	cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
};

const context: ImagesContext = {
	input: [{ type: "text", text: "Generate a dog" }],
};

describe("openrouter-images cache_creation_tokens usage", () => {
	beforeEach(() => {
		mockState.usage = undefined;
	});

	it("maps cache_creation_tokens to cacheWrite when cache_write_tokens is absent", async () => {
		// senpi#2091
		mockState.usage = {
			prompt_tokens: 100,
			completion_tokens: 4,
			prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 40 },
		};
		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.usage?.cacheWrite).toBe(40);
		expect(output.usage?.cacheRead).toBe(0);
		expect(output.usage?.input).toBe(60);
	});

	it("prefers cache_write_tokens over cache_creation_tokens", async () => {
		mockState.usage = {
			prompt_tokens: 100,
			completion_tokens: 4,
			prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30, cache_creation_tokens: 999 },
		};
		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.usage?.cacheWrite).toBe(30);
		expect(output.usage?.cacheRead).toBe(20);
		expect(output.usage?.input).toBe(50);
	});
});
