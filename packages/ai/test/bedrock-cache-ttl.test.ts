import { describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { resolvePromptCacheTtlSeconds } from "../src/index.ts";
import type { Model } from "../src/types.ts";

interface CachePointBlock {
	cachePoint?: { type: string; ttl?: string };
}

interface CapturedBedrockPayload {
	system?: CachePointBlock[];
	messages?: Array<{ content?: CachePointBlock[] }>;
}

function createModel(id: string, name: string): Model<"bedrock-converse-stream"> {
	return {
		id,
		name,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		cacheRetention: "long",
	};
}

async function capturePayload(model: Model<"bedrock-converse-stream">): Promise<CapturedBedrockPayload> {
	let capturedPayload: CapturedBedrockPayload | undefined;
	const stream = streamBedrock(
		model,
		{
			systemPrompt: "You are helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		},
		{
			signal: AbortSignal.abort(),
			onPayload: (payload) => {
				capturedPayload = payload as CapturedBedrockPayload;
				return payload;
			},
		},
	);

	for await (const event of stream) {
		if (event.type === "error") break;
	}

	if (!capturedPayload) throw new Error("Expected Bedrock payload to be captured before request abort");
	return capturedPayload;
}

function getCachePointTtls(payload: CapturedBedrockPayload): Array<string | undefined> {
	return [
		...(payload.system ?? []).flatMap((block) => (block.cachePoint ? [block.cachePoint.ttl] : [])),
		...(payload.messages ?? []).flatMap((message) =>
			(message.content ?? []).flatMap((block) => (block.cachePoint ? [block.cachePoint.ttl] : [])),
		),
	];
}

describe("Bedrock prompt-cache TTL support", () => {
	it("uses one-hour cache points and resolver TTL for Claude Opus 4.5", async () => {
		const model = createModel("us.anthropic.claude-opus-4-5-20251101-v1:0", "Claude Opus 4.5");
		const payload = await capturePayload(model);

		expect(getCachePointTtls(payload)).toEqual(["1h", "1h"]);
		expect(resolvePromptCacheTtlSeconds(model)).toBe(3600);
	});

	it("keeps Claude Opus 4.6 cache points and resolver on five minutes", async () => {
		const model = createModel("global.anthropic.claude-opus-4-6-v1", "Claude Opus 4.6");
		const payload = await capturePayload(model);

		expect(getCachePointTtls(payload)).toEqual([undefined, undefined]);
		expect(resolvePromptCacheTtlSeconds(model)).toBe(300);
	});

	it("keeps Claude 3.7 Sonnet cache points and resolver on five minutes", async () => {
		const model = createModel("us.anthropic.claude-3-7-sonnet-20250219-v1:0", "Claude 3.7 Sonnet");
		const payload = await capturePayload(model);

		expect(getCachePointTtls(payload)).toEqual([undefined, undefined]);
		expect(resolvePromptCacheTtlSeconds(model)).toBe(300);
	});
});
