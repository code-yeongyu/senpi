import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type PromptUsage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens?: number;
	cached_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		cache_creation_tokens?: number;
		audio_tokens?: number;
	};
	completion_tokens_details?: { reasoning_tokens?: number };
};

const mockState = vi.hoisted(() => ({
	usage: undefined as PromptUsage | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: mockState.usage ?? {
									prompt_tokens: 1,
									completion_tokens: 1,
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

function createModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return {
		...(baseModel as Omit<Model<"openai-completions">, "api">),
		api: "openai-completions",
	};
}

async function parseUsage(usage: PromptUsage) {
	mockState.usage = usage;
	return streamOpenAICompletions(
		createModel(),
		normalizeContext({
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}),
		{ apiKey: "test-key" },
	).result();
}

describe("openai-completions cache_creation_tokens usage", () => {
	beforeEach(() => {
		mockState.usage = undefined;
	});

	// senpi#2091 — captured 2026-09-24 from an OpenAI-compatible gateway (openai/gpt-6-luna).
	it.each([
		{
			name: "write-only turn",
			usage: {
				prompt_tokens: 4884,
				completion_tokens: 4,
				total_tokens: 4888,
				prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 4881, audio_tokens: 0 },
			},
			cacheWrite: 4881,
			cacheRead: 0,
		},
		{
			name: "read plus residual write",
			usage: {
				prompt_tokens: 4897,
				completion_tokens: 4,
				total_tokens: 4901,
				prompt_tokens_details: { cached_tokens: 4881, cache_creation_tokens: 13, audio_tokens: 0 },
			},
			cacheWrite: 13,
			cacheRead: 4881,
		},
	] as const)("maps gateway $name cache_creation_tokens to cacheWrite", async ({ usage, cacheWrite, cacheRead }) => {
		const message = await parseUsage(usage);
		expect(message.usage.cacheWrite).toBe(cacheWrite);
		expect(message.usage.cacheRead).toBe(cacheRead);
		expect(message.usage.input).toBe(usage.prompt_tokens - cacheRead - cacheWrite);
		expect(message.usage.output).toBe(usage.completion_tokens);
	});

	it("prefers cache_write_tokens when both write fields are present", async () => {
		const message = await parseUsage({
			prompt_tokens: 100,
			completion_tokens: 5,
			prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 20, cache_creation_tokens: 999 },
		});
		expect(message.usage.cacheWrite).toBe(20);
		expect(message.usage.cacheRead).toBe(10);
		expect(message.usage.input).toBe(70);
	});

	it("keeps DeepSeek prompt_cache_hit_tokens as cacheRead", async () => {
		const message = await parseUsage({
			prompt_tokens: 1000,
			completion_tokens: 8,
			prompt_cache_hit_tokens: 400,
		});
		expect(message.usage.cacheRead).toBe(400);
		expect(message.usage.cacheWrite).toBe(0);
		expect(message.usage.input).toBe(600);
	});

	it("keeps Kimi top-level cached_tokens as cacheRead", async () => {
		const message = await parseUsage({
			prompt_tokens: 1000,
			completion_tokens: 10,
			cached_tokens: 400,
		});
		expect(message.usage.cacheRead).toBe(400);
		expect(message.usage.cacheWrite).toBe(0);
		expect(message.usage.input).toBe(600);
	});
});
