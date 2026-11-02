import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
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

function createOutput(): AssistantMessage {
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

async function* completed(promptCacheDiagnostics?: unknown): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_diag",
			status: "completed",
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
			...(promptCacheDiagnostics === undefined ? {} : { prompt_cache_diagnostics: promptCacheDiagnostics }),
		},
	} as unknown as ResponseStreamEvent;
}

async function parse(promptCacheDiagnostics?: unknown): Promise<AssistantMessage> {
	const output = createOutput();
	await processResponsesStream(completed(promptCacheDiagnostics), output, new AssistantMessageEventStream(), model);
	return output;
}

// senpi#2096: record prompt_cache_diagnostics on the assistant message.
describe("openai-responses prompt_cache_diagnostics", () => {
	it("records a cache miss with its reason and token counts", async () => {
		const output = await parse({
			type: "cache_miss",
			reason: "reasoning_effort_changed",
			cache_missed_tokens: 5022,
			comparison_reusable_tokens: 5022,
		});
		expect(output.promptCacheDiagnostics).toEqual({
			type: "cache_miss",
			reason: "reasoning_effort_changed",
			cacheMissedTokens: 5022,
			comparisonReusableTokens: 5022,
		});
		expect(output.responseId).toBe("resp_diag");
	});

	it("records cache_hit and unavailable verdicts", async () => {
		await expect(parse({ type: "cache_hit" })).resolves.toMatchObject({
			promptCacheDiagnostics: { type: "cache_hit" },
		});
		await expect(parse({ type: "unavailable" })).resolves.toMatchObject({
			promptCacheDiagnostics: { type: "unavailable" },
		});
	});

	it("leaves the message untouched when the response carries no diagnostics", async () => {
		expect((await parse()).promptCacheDiagnostics).toBeUndefined();
		expect((await parse({ reason: "no type" })).promptCacheDiagnostics).toBeUndefined();
	});
});
