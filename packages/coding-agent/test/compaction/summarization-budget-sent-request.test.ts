import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, Model, StreamOptions } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { StreamDurationBudgetError } from "../../src/core/compaction/stream-watchdog.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * The summarization budget is sized to what the summary request sends. On OpenAI models the request carries
 * the agent's system prompt, its tool schemas and replayed reasoning, none of which the transcript's own
 * chars/4 estimate sees: a session the provider measured at ~146k tokens estimated well under 60k, so the
 * size-adaptive budget stayed on its 120s floor and a healthy but slow summary of that request failed with
 * "Summarization stream exceeded its 120000ms wall-clock budget".
 */

const PROVIDER_REPORTED_CONTEXT_TOKENS = 145_900;

const model = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-codex-responses",
	provider: "chatgpt-subscription",
	baseUrl: "https://chatgpt.invalid/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 500_000,
	maxTokens: 128_000,
} as Model<"openai-codex-responses">;

/** A large agent turn: the provider-reported usage covers system prompt, tools and replayed reasoning. */
function largeSessionTranscript(): AgentMessage[] {
	return [
		{ role: "user", content: [{ type: "text", text: `Refactor the module. ${"r".repeat(4_000)}` }], timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Plan.", thinkingSignature: "opaque".repeat(20_000) },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/module.ts" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 9_000,
				output: 900,
				cacheRead: PROVIDER_REPORTED_CONTEXT_TOKENS - 9_900,
				cacheWrite: 0,
				totalTokens: PROVIDER_REPORTED_CONTEXT_TOKENS,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(40_000) }],
			isError: false,
			timestamp: 3,
		},
	] as AgentMessage[];
}

/** A provider that is alive but slow: it keeps streaming deltas and never finishes. */
function slowButAliveStream(options: StreamOptions | undefined): AssistantMessageEventStream {
	const signal = options?.signal;
	return {
		async *[Symbol.asyncIterator]() {
			while (!signal?.aborted) {
				await new Promise((resolve) => setTimeout(resolve, 10_000));
				yield { type: "text_delta", contentIndex: 0, delta: "." };
			}
		},
		result: () => new Promise<never>(() => undefined),
	} as unknown as AssistantMessageEventStream;
}

function createLargeOpenAiCompaction() {
	const modelRegistry = {
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key" })),
		modelRuntime: {
			stream: (_model: unknown, _context: unknown, options: StreamOptions | undefined) =>
				slowButAliveStream(options),
		},
	} as unknown as SpeculativeCompactionContext["modelRegistry"];
	const context = {
		cwd: process.cwd(),
		model,
		sessionManager: SessionManager.inMemory(),
		modelRegistry,
		getContextUsage: () => ({ tokens: PROVIDER_REPORTED_CONTEXT_TOKENS, percent: 29, contextWindow: 500_000 }),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true as const, reason: "ok" as const })),
	} as unknown as SpeculativeCompactionContext;
	const snapshot = {
		generation: 1,
		expectedRevision: 1,
		model,
		contextWindow: 500_000,
		preparation: {
			firstKeptEntryId: "keep",
			messagesToSummarize: largeSessionTranscript(),
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: PROVIDER_REPORTED_CONTEXT_TOKENS,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		},
		promptVariant: "default" as const,
		origin: "core-route" as const,
		systemPrompt: `You are the agent. ${"s".repeat(160_000)}`,
	} as unknown as SpeculativeCompactionSnapshot;
	return { context, snapshot };
}

describe("summarization budget on a large OpenAI session", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sizes the attempt budget to the provider-measured request, not the transcript's chars", async () => {
		const { context, snapshot } = createLargeOpenAiCompaction();
		let outcome: unknown;
		void runExtensionCompaction(context, snapshot).then(
			(value) => {
				outcome = value ?? "aborted";
			},
			(error: unknown) => {
				outcome = error;
			},
		);
		for (let step = 0; step < 100 && outcome === undefined; step++) {
			await vi.advanceTimersByTimeAsync(10_000);
		}

		expect(outcome).toBeInstanceOf(StreamDurationBudgetError);
		const budgetMs = Number(/exceeded its (\d+)ms/.exec((outcome as Error).message)?.[1]);
		// 2ms per token of a ~146k-token request: the 120s floor would cut it at a third of that.
		expect(budgetMs).toBeGreaterThanOrEqual(2 * PROVIDER_REPORTED_CONTEXT_TOKENS);
	});
});
