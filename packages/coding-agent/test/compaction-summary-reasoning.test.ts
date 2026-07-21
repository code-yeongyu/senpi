import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

function createStreamFn(response: AssistantMessage): StreamFn {
	return vi.fn<StreamFn>((model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...response,
					api: model.api,
					provider: model.provider,
					model: model.id,
				},
			});
		});
		return stream;
	});
}

describe("generateSummary reasoning options", () => {
	let streamFn: StreamFn;

	beforeEach(() => {
		streamFn = createStreamFn(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
			streamFn,
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(streamFn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(streamFn).mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(
			generateSummary(
				messages,
				createModel(false),
				2000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
			),
		).resolves.toBe("## Goal\nTest summary");
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			streamFn,
		);

		expect(streamFn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(streamFn).mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(vi.mocked(streamFn).mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
			streamFn,
		);

		expect(streamFn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(streamFn).mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(vi.mocked(streamFn).mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(
			preparation,
			createModel(false, 128000),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(vi.mocked(streamFn).mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});
});
