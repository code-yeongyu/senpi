import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Tool } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/core/compaction/index.ts";
import { classifyRequiredCompactionFallbackFailure } from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
	SummaryGenerationError,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createBlockingContext, createCompactionHandlers } from "../helpers/blocking-compaction-harness.ts";

/**
 * Incident 2026-08-31: a session on openai-codex gpt-5.6-sol (high reasoning)
 * wedged above the compaction threshold with
 * "Compaction rejected: summarization response contained no text
 * (stopReason: toolUse)" followed by "Context remains above the compaction
 * threshold because compaction did not complete".
 *
 * The summarization request deliberately forwards the agent's tools so the
 * request looks like normal agent traffic (Anthropic's anti-distillation
 * classifier refuses tool-less transcript dumps). A summarizer model may
 * hijack that affordance and answer with a bare tool call: the response then
 * carries zero text blocks, which used to throw a terminal empty-summary
 * error with no retry and no deterministic recovery on required routes.
 *
 * Contract under test:
 * 1. A bare tool-call response earns exactly one retry of the same request
 *    with `toolChoice: "none"`. Tools stay in the retried request because
 *    Anthropic rejects histories containing tool_use blocks when the tools
 *    param is absent.
 * 2. A persistent empty-summary failure is classified into the deterministic
 *    no-LLM fallback on required-compaction routes instead of wedging the
 *    session above the threshold.
 */

const CONTEXT_WINDOW = 200_000;

const SUMMARIZATION_TOOLS: Tool[] = [
	{
		name: "read",
		description: "Read a file from disk",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

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

function createModelContext(options?: { tools?: Tool[] }) {
	const registration = registerFauxProvider({ models: [{ id: "sol-high", contextWindow: CONTEXT_WINDOW }] });
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

function toolChoiceOf(entry: { options?: unknown } | undefined): unknown {
	return (entry?.options as { toolChoice?: unknown } | undefined)?.toolChoice;
}

describe("summarization tool-call hijack retry", () => {
	it("Given a summarizer that answers with a bare tool call When compaction runs Then the request is retried once with toolChoice none and the retry summary is used", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([bareToolCallResponse(), fauxAssistantMessage("recovered summary")]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("recovered summary");
		const calls = registration.getCallLog();
		expect(calls).toHaveLength(2);
		expect(calls[0]?.context.tools).toHaveLength(1);
		expect(toolChoiceOf(calls[0])).toBeUndefined();
		expect(calls[1]?.context.tools).toHaveLength(1);
		expect(toolChoiceOf(calls[1])).toBe("none");
	});

	it("Given persistent bare tool calls When compaction runs Then exactly one retry is spent before empty-summary surfaces", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([bareToolCallResponse(), bareToolCallResponse()]);

		let caught: unknown;
		try {
			await runExtensionCompaction(context, snapshot);
		} catch (error) {
			caught = error;
		}

		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect((caught as { kind?: string } | undefined)?.kind).toBe("empty-summary");
		expect((caught as Error | undefined)?.message).toContain("stopReason: toolUse");
		expect(registration.getCallLog()).toHaveLength(2);
	});

	it("Given a request that offered no tools When the model still stops on toolUse Then no retry is spent", async () => {
		const { registration, context, snapshot } = createModelContext();
		registration.setResponses([bareToolCallResponse()]);

		let caught: unknown;
		try {
			await runExtensionCompaction(context, snapshot);
		} catch (error) {
			caught = error;
		}

		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect(registration.getCallLog()).toHaveLength(1);
	});
});

describe("empty-summary deterministic fallback classification", () => {
	it("classifies empty-summary failures into the deterministic fallback", () => {
		expect(
			classifyRequiredCompactionFallbackFailure(
				new SummaryGenerationError(
					"empty-summary",
					"summarization response contained no text (stopReason: toolUse)",
				),
			),
		).toBe("summarization-empty-summary");
	});

	it("never classifies auth failures into the fallback", () => {
		expect(
			classifyRequiredCompactionFallbackFailure(
				new SummaryGenerationError("auth", "summarization credentials unavailable: no API key configured"),
			),
		).toBeUndefined();
	});
});

describe("required compaction recovery from summarizer tool-call hijack", () => {
	it("Given a manual compaction whose summarizer only tool-calls When the handler runs Then the deterministic fallback engages instead of cancelling", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.registration.setResponses([bareToolCallResponse()]);
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "manual",
				willRetry: false,
				requestId: "manual-tooluse-hijack-recovery",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		if (!result) throw new Error("Expected a compaction handler result");
		expect(result).not.toHaveProperty("cancel");
		expect(result).toMatchObject({
			compaction: {
				details: {
					failureKind: "summarization-empty-summary",
					origin: "required-compaction-recovery",
				},
			},
		});

		// Two subsequent unclassified threshold failures must not trip the breaker:
		// the manual recovery itself must not have recorded a failure.
		harness.registration.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unclassified failure" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unclassified failure" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "unclassified failure" }),
		]);
		for (let attempt = 0; attempt < 3; attempt++) {
			await handlers.sessionBeforeCompact(
				{
					type: "session_before_compact",
					reason: "threshold",
					willRetry: false,
					requestId: `breaker-probe-${attempt}`,
					preparation: preparation!,
					branchEntries,
					signal: new AbortController().signal,
				},
				harness.ctx,
			);
		}
		expect(harness.registration.getCallLog()).toHaveLength(4);
	});

	it("Given a manual compaction whose summarizer times out When the handler runs Then the deterministic fallback engages", async () => {
		vi.useFakeTimers();
		try {
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_900 });
			harness.registration.setResponses([async () => await new Promise<never>(() => undefined)]);
			const branchEntries = harness.ctx.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
			const resultPromise = handlers.sessionBeforeCompact(
				{
					type: "session_before_compact",
					reason: "manual",
					willRetry: false,
					requestId: "manual-timeout-recovery",
					preparation: preparation!,
					branchEntries,
					signal: new AbortController().signal,
				},
				harness.ctx,
			);
			await vi.advanceTimersByTimeAsync(120_001);
			await expect(resultPromise).resolves.toMatchObject({
				compaction: {
					details: { origin: "required-compaction-recovery", failureKind: "summarization-timeout" },
				},
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps idle and speculative-origin failures fail-closed", async () => {
		for (const reason of ["pre_prompt", "extension"] as const) {
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_900 });
			harness.registration.setResponses([bareToolCallResponse()]);
			const branchEntries = harness.ctx.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
			const result = await handlers.sessionBeforeCompact(
				{
					type: "session_before_compact",
					reason,
					willRetry: false,
					requestId: `fail-closed-${reason}`,
					preparation: preparation!,
					branchEntries,
					signal: new AbortController().signal,
				},
				harness.ctx,
			);
			expect(result).toMatchObject({ cancel: true });
			expect(result).not.toHaveProperty("compaction");
		}
	});

	it("keeps manual auth failures fail-closed", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900, withAuth: false });
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "manual",
				willRetry: false,
				requestId: "manual-auth-failure",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);
		expect(result).toMatchObject({ cancel: true });
		expect(result).not.toHaveProperty("compaction");
	});
});
