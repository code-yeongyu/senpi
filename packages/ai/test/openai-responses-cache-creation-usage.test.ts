import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function* completed(usage: {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details: Record<string, number>;
	output_tokens_details?: { reasoning_tokens?: number };
}): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_cache_creation",
			status: "completed",
			usage,
		},
	} as unknown as ResponseStreamEvent;
}

async function parseUsage(usage: {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details: Record<string, number>;
	output_tokens_details?: { reasoning_tokens?: number };
}) {
	const model = createModel();
	const output = createOutput(model);
	await processResponsesStream(completed(usage), output, new AssistantMessageEventStream(), model);
	return output.usage;
}

describe("openai-responses cache_creation_tokens usage", () => {
	// senpi#2091 — captured 2026-09-24 from an OpenAI-compatible gateway (openai/gpt-6-luna).
	it.each([
		{
			name: "write-only turn",
			usage: {
				input_tokens: 4889,
				output_tokens: 5,
				total_tokens: 4894,
				input_tokens_details: { cached_tokens: 0, cache_creation_tokens: 4886 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
			cacheWrite: 4886,
			cacheRead: 0,
		},
		{
			name: "read plus residual write",
			usage: {
				input_tokens: 4904,
				output_tokens: 5,
				total_tokens: 4909,
				input_tokens_details: { cached_tokens: 4886, cache_creation_tokens: 15 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
			cacheWrite: 15,
			cacheRead: 4886,
		},
	] as const)("maps gateway $name cache_creation_tokens to cacheWrite", async ({ usage, cacheWrite, cacheRead }) => {
		const parsed = await parseUsage(usage);
		expect(parsed.cacheWrite).toBe(cacheWrite);
		expect(parsed.cacheRead).toBe(cacheRead);
		expect(parsed.input).toBe(usage.input_tokens - cacheRead - cacheWrite);
		expect(parsed.output).toBe(usage.output_tokens);
		expect(parsed.totalTokens).toBe(usage.total_tokens);
	});

	it("prefers cache_write_tokens when both write fields are present", async () => {
		const parsed = await parseUsage({
			input_tokens: 100,
			output_tokens: 7,
			total_tokens: 107,
			input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20, cache_creation_tokens: 999 },
		});
		expect(parsed.cacheWrite).toBe(20);
		expect(parsed.cacheRead).toBe(10);
		expect(parsed.input).toBe(70);
	});
});
