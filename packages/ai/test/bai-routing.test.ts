import { describe, expect, it, vi } from "vitest";
import type { Context, Model, ProviderStreams } from "../src/types.ts";

const calls = vi.hoisted(() => [] as string[]);

function recordingStreams(label: string): ProviderStreams {
	const record = (model: Model<string>) => {
		calls.push(`${label}:${model.id}`);
		return {} as ReturnType<ProviderStreams["stream"]>;
	};
	return {
		stream: record,
		streamSimple: record,
	};
}

vi.mock("../src/api/openai-responses.lazy.ts", () => ({
	openAIResponsesApi: () => recordingStreams("responses"),
}));
vi.mock("../src/api/openai-completions.lazy.ts", () => ({
	openAICompletionsApi: () => recordingStreams("completions"),
}));
vi.mock("../src/api/anthropic-messages.lazy.ts", () => ({
	anthropicMessagesApi: () => recordingStreams("messages"),
}));

import { baiProvider } from "../src/providers/bai.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

function model<TApi extends "openai-responses" | "openai-completions" | "anthropic-messages">(
	id: string,
	api: TApi,
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider: "bai",
		baseUrl: api === "anthropic-messages" ? "https://api.b.ai" : "https://api.b.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("B.AI protocol routing", () => {
	it("dispatches each model family through its declared wire API", async () => {
		calls.length = 0;
		const catalog = [
			model("gpt-5.6-sol", "openai-responses"),
			model("claude-sonnet-5", "anthropic-messages"),
			model("gemini-3.8-flash", "openai-completions"),
		];
		const provider = baiProvider({
			models: catalog,
			fetch: async () =>
				Response.json({
					data: catalog.map(({ id }) => ({ id })),
				}),
		});
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});

		for (const entry of provider.getModels()) {
			provider.streamSimple(entry, normalizeContext(context), { apiKey: "test-key" });
		}

		expect(calls).toEqual(["responses:gpt-5.6-sol", "messages:claude-sonnet-5", "completions:gemini-3.8-flash"]);
	});
});
