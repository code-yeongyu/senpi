// Issue #1741: a summarization stream killed by a provider or credential failure
// must never leave the session uncontinuable. The reporter's session repeated
// `senpi:no-turn-retry:Codex error: …` on every prompt because the terminal
// provider error was not a recognized deterministic-fallback class, so required
// compaction rethrew it, the marker suppressed session retry and model fallback,
// and the context stayed above the threshold forever.
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeSummarization } from "../../src/core/compaction/compaction.ts";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import {
	consumeStreamWithIdleTimeout,
	DEFAULT_SUMMARIZATION_MAX_DURATION_MS,
	StreamDurationBudgetError,
} from "../../src/core/compaction/stream-watchdog.ts";
import { CredentialFailoverError, TURN_RETRY_SUPPRESSION_PREFIX } from "../../src/core/credential-pool/failover.ts";
import { classifyRequiredCompactionFallbackFailure } from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import {
	SummaryGenerationError,
	SummaryRequestError,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";
import { createBlockingContext, createCompactionHandlers } from "../helpers/blocking-compaction-harness.ts";
import { OPENAI_NATIVE_LEGACY_MODEL } from "./openai-remote-test-models.ts";

/** Exactly what `runCredentialFailover` rethrows once any event past `start` reached the caller. */
function markerBearingFailover(detail = "Codex error: stream ended with an error response"): CredentialFailoverError {
	return new CredentialFailoverError({ kind: "fail_request" }, new Error(detail), { suppressTurnRetry: true });
}

function partialMessage(model: Model<any>): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function startEvent(model: Model<any>): AssistantMessageEvent {
	return { type: "start", partial: partialMessage(model) };
}

/**
 * Replace the harness model runtime with one whose summarization stream commits
 * output and then throws — the shape credential rotation produces, and the shape
 * the faux provider cannot express (it converts throws into error stops).
 */
function installThrowingSummarizationRuntime(ctx: ExtensionContext, error: unknown): () => number {
	let calls = 0;
	const runtime = {
		stream: (model: Model<any>) => {
			calls++;
			const stream = createAssistantMessageEventStream();
			stream.push(startEvent(model));
			stream.push({ type: "text_delta", contentIndex: 0, delta: "partial summary", partial: partialMessage(model) });
			stream.fail(error);
			return stream;
		},
	};
	(ctx.modelRegistry as unknown as { modelRuntime: typeof runtime }).modelRuntime = runtime;
	return () => calls;
}

describe("summarization provider failure authorizes the deterministic fallback", () => {
	it("classifies a marker-bearing credential failover error as a provider failure", () => {
		expect(classifyRequiredCompactionFallbackFailure(markerBearingFailover())).toBe("summarization-provider-failure");
		// A pool that never committed output rethrows without the marker; it is just
		// as terminal for this summary, so it authorizes the same recovery.
		expect(
			classifyRequiredCompactionFallbackFailure(
				new CredentialFailoverError({ kind: "fail_request" }, new Error("all slots blocked"), {
					suppressTurnRetry: false,
				}),
			),
		).toBe("summarization-provider-failure");
		// Single-key providers have no rotation wrapper: the same outage arrives as a
		// bare error carrying the marker minted by another failover lane.
		expect(
			classifyRequiredCompactionFallbackFailure(new Error(`${TURN_RETRY_SUPPRESSION_PREFIX}Codex error: boom`)),
		).toBe("summarization-provider-failure");
	});

	it("classifies a non-transient summary request error as a provider failure", () => {
		expect(classifyRequiredCompactionFallbackFailure(new SummaryRequestError("Codex error: boom", false))).toBe(
			"summarization-provider-failure",
		);
	});

	it("keeps aborts, refusals and retryable failures out of the destructive fallback", () => {
		// A refusal must stay loud: reducing context would not make the model comply.
		expect(
			classifyRequiredCompactionFallbackFailure(new SummaryRequestError("refused", false, undefined, true)),
		).toBeUndefined();
		// A transient provider failure is answered by another attempt, not by dropping context.
		expect(classifyRequiredCompactionFallbackFailure(new SummaryRequestError("overloaded", true))).toBeUndefined();
		// Missing credentials are a configuration fault with an actionable message.
		expect(
			classifyRequiredCompactionFallbackFailure(
				new SummaryGenerationError("auth", "summarization credentials unavailable: no API key configured"),
			),
		).toBeUndefined();
		// An ordinary bug must not authorize destructive context reduction.
		expect(
			classifyRequiredCompactionFallbackFailure(new TypeError("cannot read properties of undefined")),
		).toBeUndefined();
	});

	it("applies a deterministic checkpoint when the blocking route's summary stream throws a marker error", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const summarizationCalls = installThrowingSummarizationRuntime(harness.ctx, markerBearingFailover());
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				requestId: "issue-1741-marker",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		if (!result) throw new Error("Expected a compaction handler result");
		// The wedge was `{ cancel: true }`: compaction never applied, so the context
		// stayed over threshold and the next prompt repeated the identical failure.
		expect(result).not.toHaveProperty("cancel");
		expect(result).toMatchObject({
			compaction: {
				details: {
					schema: "senpi.compaction.deterministic-fallback.v1",
					origin: "required-compaction-recovery",
					failureKind: "summarization-provider-failure",
				},
			},
		});
		// The marker class is terminal: it must never be re-billed as a retry.
		expect(summarizationCalls()).toBe(1);

		// The next turn proceeds: applying the checkpoint drops the bulk that kept the
		// session above the threshold while the live request survives.
		const compaction = result.compaction;
		if (!compaction) throw new Error("Expected deterministic recovery compaction");
		harness.sessionManager.appendCompaction(
			compaction.summary,
			compaction.firstKeptEntryId,
			compaction.tokensBefore,
			compaction.details,
			true,
		);
		const retained = JSON.stringify(harness.sessionManager.buildSessionContext().messages);
		expect(retained).toContain("Keep latest request");
		expect(retained).not.toContain("Old assistant context");
	});

	it("recovers the blocking route from a non-transient provider error stop", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: `${TURN_RETRY_SUPPRESSION_PREFIX}Codex error: stream ended with an error response`,
			}),
		]);
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);

		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				requestId: "issue-1741-error-stop",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		if (!result) throw new Error("Expected a compaction handler result");
		expect(result).not.toHaveProperty("cancel");
		expect(result).toMatchObject({
			compaction: { details: { failureKind: "summarization-provider-failure" } },
		});
		expect(harness.registration.getCallLog()).toHaveLength(1);
	});

	it("tells the user plainly what happened without the internal retry-suppression marker", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const notify = vi.fn();
		(harness.ctx as unknown as { ui: { notify: typeof notify } }).ui = { notify };
		const failure = markerBearingFailover();
		installThrowingSummarizationRuntime(harness.ctx, failure);
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);

		await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				requestId: "issue-1741-message",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		// The marker stays on the internal error the session-level retry-suppression
		// predicates read, and never reaches what the user is shown.
		expect(failure.message.startsWith(TURN_RETRY_SUPPRESSION_PREFIX)).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
		const [message] = notify.mock.calls[0] as [string, string?];
		expect(message).not.toContain(TURN_RETRY_SUPPRESSION_PREFIX);
		expect(message).toContain("could not complete a provider summary");
		expect(message).toContain("deterministic checkpoint was applied");
		expect(message).toContain("safe to continue");
		for (const call of harness.endCompaction.mock.calls as Array<[{ errorMessage?: string }]>) {
			expect(call[0]?.errorMessage ?? "").not.toContain(TURN_RETRY_SUPPRESSION_PREFIX);
		}
	});
});

describe("summarization settlement stays inside the watched budget", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("bounds a stream whose iterator ends without a terminal result event", async () => {
		let aborted = false;
		const outcome = consumeStreamWithIdleTimeout<{ type: string }, string>(
			{
				async *[Symbol.asyncIterator]() {
					yield { type: "start" };
				},
			},
			{
				idleTimeoutMs: 10_000,
				maxDurationMs: 500,
				abort: () => {
					aborted = true;
				},
				// A provider that ends its iterator without pushing `done`/`error`
				// leaves `result()` pending forever.
				settle: () => new Promise<string>(() => undefined),
			},
		).catch((caught: unknown) => caught);

		await vi.advanceTimersByTimeAsync(600);

		expect(await outcome).toBeInstanceOf(StreamDurationBudgetError);
		expect(aborted).toBe(true);
	});

	it("bounds completeSummarization when the provider never settles its result", async () => {
		let requestSignal: AbortSignal | undefined;
		const outcome = completeSummarization(
			OPENAI_NATIVE_LEGACY_MODEL,
			{ systemPrompt: "", messages: [] },
			{ maxTokens: 32 },
			(_model, _context, options) => {
				requestSignal = options?.signal;
				const stream = createAssistantMessageEventStream();
				stream.push(startEvent(OPENAI_NATIVE_LEGACY_MODEL));
				// Iterator done, `result()` never resolves: today this parks compaction
				// with no timer armed at all.
				stream.end();
				return stream;
			},
		).catch((caught: unknown) => caught);

		await vi.advanceTimersByTimeAsync(DEFAULT_SUMMARIZATION_MAX_DURATION_MS + 1);

		const pending = Symbol("pending");
		const observed = await Promise.race([outcome, Promise.resolve(pending)]);
		expect(observed).toBeInstanceOf(StreamDurationBudgetError);
		expect(requestSignal?.aborted).toBe(true);
	});
});
