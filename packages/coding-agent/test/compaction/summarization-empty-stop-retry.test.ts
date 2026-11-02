import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Tool } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Incident 2026-09-17: a z-ai/glm-5.3-flash session behind a custom
 * OpenAI-completions relay surfaced "Compaction rejected: summarization
 * response contained no text (stopReason: stop)" on large tool-bearing
 * summarization prompts. The gateway recorded HTTP 200 SSE responses carrying
 * only the role prelude (completion=7 tokens): the relay completed "normally"
 * with zero text whenever the request pinned an explicit reasoning effort,
 * while ordinary agent traffic on the same model (no effort pin) answered.
 *
 * The summarizer deliberately pins a reasoning override (effort for OpenAI
 * wire families, `thinkingEnabled: false` for Anthropic) to keep compaction
 * cheap. Dropping that override is the one request-level lever the summarizer
 * owns, so an empty stop earns exactly one retry WITHOUT it before the terminal
 * empty-summary error surfaces — and only when the first attempt actually
 * carried an override. A model that never received one (non-reasoning, or an
 * api family with no override) keeps the single-call terminal contract: a
 * byte-identical replay of a near-window-size prompt is cost with no lever.
 * Persistent emptiness keeps the existing contract: SummaryGenerationError +
 * deterministic fallback classification.
 */

const CONTEXT_WINDOW = 200_000;

const SUMMARIZATION_TOOLS: Tool[] = [
	{
		name: "read",
		description: "Read a file from disk",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

function emptyStopResponse() {
	return fauxAssistantMessage("", { stopReason: "stop" });
}

function bareToolCallResponse() {
	return fauxAssistantMessage([fauxToolCall("read", { path: "/tmp/x" })], { stopReason: "toolUse" });
}

function shortHistory() {
	return [
		{ role: "user" as const, content: [{ type: "text" as const, text: "please refactor the parser" }], timestamp: 1 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done: parser refactored" }],
			timestamp: 2,
		},
	];
}

function optionsOf(entry: { options?: unknown } | undefined): Record<string, unknown> {
	return (entry?.options as Record<string, unknown> | undefined) ?? {};
}

function reasoningEffortOf(entry: { options?: unknown } | undefined): unknown {
	return optionsOf(entry).reasoningEffort;
}

function toolChoiceOf(entry: { options?: unknown } | undefined): unknown {
	return optionsOf(entry).toolChoice;
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return undefined;
}

function createModelContext(options?: { api?: string; reasoning?: boolean; tools?: Tool[] }) {
	const registration = registerFauxProvider({
		api: options?.api ?? "openai-completions",
		models: [{ id: "summarizer-faux", reasoning: options?.reasoning ?? true, contextWindow: CONTEXT_WINDOW }],
	});
	const model = registration.getModel();
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = Object.create(null) as SpeculativeCompactionContext["modelRegistry"];
	if (modelRegistry) {
		modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "test-key" }));
	}
	const context = {
		model,
		sessionManager,
		modelRegistry,
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: CONTEXT_WINDOW }),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true as const, reason: "ok" as const })),
	} as unknown as SpeculativeCompactionContext;
	const snapshot = {
		generation: 1,
		expectedRevision: 1,
		model,
		contextWindow: CONTEXT_WINDOW,
		preparation: {
			firstKeptEntryId: "keep",
			messagesToSummarize: shortHistory(),
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 12_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		},
		promptVariant: "default" as const,
		origin: "blocking" as const,
		systemPrompt: "agent system prompt",
		...(options?.tools ? { tools: options.tools } : {}),
	} as unknown as SpeculativeCompactionSnapshot;
	return { registration, context, snapshot };
}

describe("summarization empty-stop reasoning-override retry", () => {
	it("Given a reasoning summarizer that stops with no text When compaction runs Then the request is retried once without the reasoning effort override and the retry summary is used", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([emptyStopResponse(), fauxAssistantMessage("recovered summary")]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("recovered summary");
		const calls = registration.getCallLog();
		expect(calls).toHaveLength(2);
		expect(reasoningEffortOf(calls[0])).toBe("low");
		expect(reasoningEffortOf(calls[1])).toBeUndefined();
	});

	it("Given persistent empty stop responses When compaction runs Then exactly one retry is spent before empty-summary surfaces", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([emptyStopResponse(), emptyStopResponse()]);

		const caught = await captureFailure(() => runExtensionCompaction(context, snapshot));

		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect((caught as { kind?: string } | undefined)?.kind).toBe("empty-summary");
		expect((caught as Error | undefined)?.message).toContain("stopReason: stop");
		expect(registration.getCallLog()).toHaveLength(2);
	});

	it("Given a non-reasoning summarizer that stops with no text When compaction runs Then no retry is spent because the first request carried no override to drop", async () => {
		const { registration, context, snapshot } = createModelContext({ reasoning: false, tools: SUMMARIZATION_TOOLS });
		// A second response is queued on purpose: if the loop replayed the
		// identical request it would consume it and this test would pass for the
		// wrong reason, so the call count is the assertion that matters.
		registration.setResponses([emptyStopResponse(), fauxAssistantMessage("must not be requested")]);

		const caught = await captureFailure(() => runExtensionCompaction(context, snapshot));

		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect((caught as { kind?: string } | undefined)?.kind).toBe("empty-summary");
		expect((caught as Error | undefined)?.message).toContain("stopReason: stop");
		const calls = registration.getCallLog();
		expect(calls).toHaveLength(1);
		expect(reasoningEffortOf(calls[0])).toBeUndefined();
	});

	it("Given an Anthropic reasoning summarizer that stops with no text When compaction runs Then the retry drops the thinkingEnabled=false override and the retry summary is used", async () => {
		const { registration, context, snapshot } = createModelContext({
			api: "anthropic-messages",
			tools: SUMMARIZATION_TOOLS,
		});
		registration.setResponses([emptyStopResponse(), fauxAssistantMessage("recovered summary")]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("recovered summary");
		const calls = registration.getCallLog();
		expect(calls).toHaveLength(2);
		expect(optionsOf(calls[0]).thinkingEnabled).toBe(false);
		expect("thinkingEnabled" in optionsOf(calls[1])).toBe(false);
		expect("reasoningEffort" in optionsOf(calls[1])).toBe(false);
	});

	it("Given a bare tool call and then an empty stop When compaction runs Then the third request carries both toolChoice none and no reasoning override and its summary is used", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([
			bareToolCallResponse(),
			emptyStopResponse(),
			fauxAssistantMessage("recovered summary"),
		]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("recovered summary");
		const calls = registration.getCallLog();
		expect(calls).toHaveLength(3);
		expect(toolChoiceOf(calls[0])).toBeUndefined();
		expect(reasoningEffortOf(calls[0])).toBe("low");
		expect(toolChoiceOf(calls[1])).toBe("none");
		expect(reasoningEffortOf(calls[1])).toBe("low");
		expect(toolChoiceOf(calls[2])).toBe("none");
		expect(reasoningEffortOf(calls[2])).toBeUndefined();
	});

	it("Given a bare tool call and then persistent empty stops When compaction runs Then both retries are spent once and empty-summary surfaces at three calls", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([
			bareToolCallResponse(),
			emptyStopResponse(),
			emptyStopResponse(),
			fauxAssistantMessage("must not be requested"),
		]);

		const caught = await captureFailure(() => runExtensionCompaction(context, snapshot));

		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect((caught as { kind?: string } | undefined)?.kind).toBe("empty-summary");
		expect((caught as Error | undefined)?.message).toContain("stopReason: stop");
		expect(registration.getCallLog()).toHaveLength(3);
	});
});
