import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertMessages as convertGoogleMessages } from "../../../ai/src/api/google-shared.ts";
import { transformMessages } from "../../../ai/src/api/transform-messages.ts";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import { StreamDurationBudgetError } from "../../src/core/compaction/stream-watchdog.ts";
import {
	classifyRequiredCompactionFallbackFailure,
	createRequiredCompactionFallback,
} from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { resolveCompactionGeometry } from "../../src/core/extensions/builtin/compaction/orchestration.ts";
import { SummaryRequestError } from "../../src/core/extensions/builtin/compaction/speculative.ts";
import type { CompactionReason } from "../../src/core/extensions/types.ts";
import { createBlockingContext, createCompactionHandlers } from "../helpers/blocking-compaction-harness.ts";

const validSig = "c2lnbmF0dXJlMTIzNA==";

function createGeminiAssistantMessage(
	content: AssistantMessage["content"],
	options: { timestamp?: number; stopReason?: AssistantMessage["stopReason"] } = {},
): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			timestamp: options.timestamp ?? 4,
			stopReason: options.stopReason ?? "toolUse",
		}),
		provider: "google",
		model: "gemini-3-flash",
		api: "google-generative-ai",
		content,
	};
}

describe("required compaction deterministic fallback", () => {
	it("advances to the latest user boundary when the prepared suffix cannot fit", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: Responses stream ended before a terminal event",
			}),
		]);
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				requestId: "required-fallback",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		const latestRequest = branchEntries.at(-1);
		if (latestRequest?.type !== "message" || latestRequest.message.role !== "user") {
			throw new Error("Expected the latest persisted entry to be the user request");
		}
		if (!result) throw new Error("Expected a compaction handler result");
		expect(result).toMatchObject({
			compaction: {
				firstKeptEntryId: latestRequest.id,
				details: { retainedSuffix: "latest-user-turn" },
			},
		});
		expect(result).not.toHaveProperty("cancel");
		const compaction = result.compaction;
		if (!compaction) throw new Error("Expected deterministic recovery compaction");
		harness.sessionManager.appendCompaction(
			compaction.summary,
			compaction.firstKeptEntryId,
			compaction.tokensBefore,
			compaction.details,
			true,
		);
		const retainedContext = JSON.stringify(harness.sessionManager.buildSessionContext().messages);
		expect(retainedContext.match(/Keep latest request/g)).toHaveLength(1);
		expect(retainedContext).not.toContain("Old assistant context");
		expect(harness.registration.getCallLog()).toHaveLength(1);
	});

	it("keeps a skill-bearing prepared suffix when only retained provider usage is stale", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparedBoundaryId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 4, stopReason: "toolUse" }),
			content: [{ type: "toolCall", id: "read-skill", name: "read", arguments: { path: "SKILL.md" } }],
			usage: {
				input: 30_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "read-skill",
			toolName: "read",
			content: [{ type: "text", text: "skill loaded" }],
			isError: false,
			timestamp: 5,
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: `<skill name="ulw-mutation-test">${"mutation contract ".repeat(300)}</skill>`,
			timestamp: 6,
		});
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = createRequiredCompactionFallback(
			{ ...preparation!, firstKeptEntryId: preparedBoundaryId },
			10_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toMatchObject({
			firstKeptEntryId: preparedBoundaryId,
			details: { retainedSuffix: "prepared" },
		});
	});

	it("does not recover aborted or unrelated failures", async () => {
		for (const testCase of [
			{ reason: "threshold" as const, message: "upstream_stream_truncated", aborted: true, refusal: false },
			{ reason: "threshold" as const, message: "unrelated provider refusal", aborted: false, refusal: false },
			{ reason: "threshold" as const, message: "upstream_stream_truncated", aborted: false, refusal: true },
		]) {
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_900 });
			harness.registration.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: testCase.message,
					...(testCase.refusal ? { stopDetails: { type: "refusal" as const } } : {}),
				}),
			]);
			const branchEntries = harness.ctx.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
			const controller = new AbortController();
			if (testCase.aborted) controller.abort();
			const result = await handlers.sessionBeforeCompact(
				{
					type: "session_before_compact",
					reason: testCase.reason,
					willRetry: false,
					requestId: `fail-closed-${testCase.reason}-${testCase.aborted}`,
					preparation: preparation!,
					branchEntries,
					signal: controller.signal,
				},
				harness.ctx,
			);
			if (testCase.aborted) {
				// A pre-aborted request stands down without a cancel result (issue
				// #886): core's aborted classification renders the cancellation, and
				// no session_compact accepted:false reaches the circuit breaker.
				expect(result).toBeUndefined();
			} else {
				expect(result).toMatchObject({ cancel: true });
			}
			expect(result ?? {}).not.toHaveProperty("compaction");
		}
	});

	it("fails closed for every non-required reason even when typed truncation recovery would fit", async () => {
		const nonRequiredReasons = ["pre_prompt", "branch", "extension"] satisfies CompactionReason[];
		for (const reason of nonRequiredReasons) {
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_900 });
			harness.registration.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "upstream_stream_truncated: Responses stream ended before a terminal event",
				}),
			]);
			const branchEntries = harness.ctx.sessionManager.getBranch();
			const preparation = {
				...prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!,
				firstKeptEntryId: branchEntries.at(-1)?.id ?? "",
			};
			expect(
				createRequiredCompactionFallback(preparation, 10_000, "upstream-stream-truncated", {}, branchEntries),
			).toBeDefined();

			const result = await handlers.sessionBeforeCompact(
				{
					type: "session_before_compact",
					reason,
					willRetry: false,
					requestId: `non-required-${reason}`,
					preparation,
					branchEntries,
					signal: new AbortController().signal,
				},
				harness.ctx,
			);

			expect(result).toMatchObject({
				cancel: true,
				reason:
					"compaction generator failed: upstream_stream_truncated: Responses stream ended before a terminal event",
			});
			expect(result).not.toHaveProperty("compaction");
			expect(harness.registration.getCallLog()).toHaveLength(1);
		}
	});

	it("classifies a duration watchdog without sleeping", () => {
		expect(classifyRequiredCompactionFallbackFailure(new StreamDurationBudgetError(120_000))).toBe(
			"summarization-timeout",
		);
	});

	it("rejects truncation-looking generic errors and requires structured summary-request provenance", () => {
		const truncationMessage = "upstream_stream_truncated: Responses stream ended before a terminal event";
		for (const error of [
			new Error(truncationMessage),
			new Error("provider wrapper saw upstream-stream-truncated while handling another failure"),
			new SummaryRequestError(truncationMessage, true),
			new SummaryRequestError(truncationMessage, false, "upstream-stream-truncated"),
		]) {
			expect(classifyRequiredCompactionFallbackFailure(error)).toBeUndefined();
		}
		expect(
			classifyRequiredCompactionFallbackFailure(
				new SummaryRequestError(truncationMessage, true, "upstream-stream-truncated"),
			),
		).toBe("upstream-stream-truncated");
	});

	it("requires a real suffix and preserves bounded task intent and prior checkpoint text", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();
		expect(
			createRequiredCompactionFallback(
				{ ...preparation!, firstKeptEntryId: "" },
				100_000,
				"summarization-timeout",
				{},
				branchEntries,
			),
		).toBeUndefined();

		const result = createRequiredCompactionFallback(
			{
				...preparation!,
				firstKeptEntryId: branchEntries.at(-1)?.id ?? "",
				previousSummary: "status ".repeat(10_000),
			},
			100_000,
			"summarization-timeout",
			{
				taskIntent: "Finish the current repair",
				todoSnapshot: { items: ["verify recovery"] },
				checkpoint: { files: ["agent-session.ts"] },
			},
			branchEntries,
		);

		expect(result).toBeDefined();
		expect(result?.summary).not.toContain("\uFFFD");
		expect(result?.summary).toContain("Finish the current repair");
		expect(result?.summary).toContain("Previous checkpoint:");
		expect(result?.summary).toContain("[Older checkpoint truncated]");
		expect(Buffer.byteLength(result!.summary)).toBeLessThanOrEqual(40_000);
		expect(result?.summary).not.toContain("verify recovery");
		expect(result?.summary).not.toContain("agent-session.ts");
		expect(result?.details).toEqual({
			schema: "senpi.compaction.deterministic-fallback.v1",
			origin: "required-compaction-recovery",
			failureKind: "summarization-timeout",
			taskIntent: "Finish the current repair",
			retainedSuffix: "prepared",
		});
		harness.sessionManager.appendCompaction(
			result!.summary,
			result!.firstKeptEntryId,
			result!.tokensBefore,
			result!.details,
			true,
		);
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toContain("Keep latest request");
	});

	it("fails closed instead of throwing on malformed retained content blocks", () => {
		for (const malformedMessage of [
			{ role: "user", content: [null], timestamp: 4 },
			{ role: "user", content: [{ type: "text" }], timestamp: 4 },
			{ role: "user", content: [{ type: "text", text: 42 }], timestamp: 4 },
			{ role: "user", content: "missing timestamp" },
			{ role: "toolResult", toolCallId: "tool", toolName: "read", content: "text", isError: false, timestamp: 4 },
			{
				role: "toolResult",
				toolName: "read",
				content: [{ type: "text", text: "missing tool call id" }],
				isError: false,
				timestamp: 4,
			},
			{
				role: "custom",
				customType: "test",
				content: "missing display",
				timestamp: 4,
			},
			{
				role: "bashExecution",
				command: "pwd",
				output: "/tmp",
				exitCode: 0,
				cancelled: false,
				timestamp: 4,
			},
			{ role: "assistant", content: [{ type: "text", text: "missing envelope" }], timestamp: 4 },
			{ ...fauxAssistantMessage("", { timestamp: 4 }), content: [{ type: "text" }] },
			{ ...fauxAssistantMessage("", { timestamp: 4 }), content: [{ type: "thinking" }] },
			{ ...fauxAssistantMessage("", { timestamp: 4 }), content: [{ type: "toolCall" }] },
		]) {
			const harness = createBlockingContext({ usageTokens: 9_900 });
			const validBranch = harness.sessionManager.getBranch();
			const preparation = prepareCompaction(validBranch, harness.ctx.getCompactionSettings(), true);
			expect(preparation).toBeDefined();
			const malformedId = harness.sessionManager.appendMessage(malformedMessage as never);
			const branchEntries = harness.sessionManager.getBranch();
			let result: ReturnType<typeof createRequiredCompactionFallback>;

			expect(() => {
				result = createRequiredCompactionFallback(
					{ ...preparation!, firstKeptEntryId: malformedId },
					100_000,
					"summarization-timeout",
					{},
					branchEntries,
				);
			}).not.toThrow();
			expect(result!).toBeUndefined();
		}
	});

	it("fails closed on malformed retained message envelopes", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		const malformedBoundary = branchEntries.at(-1)!;
		const malformedBranch = branchEntries.map((entry) =>
			entry.id === malformedBoundary.id ? { ...entry, message: null } : entry,
		) as never;
		let result: ReturnType<typeof createRequiredCompactionFallback>;

		expect(() => {
			result = createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: malformedBoundary.id },
				100_000,
				"summarization-timeout",
				{},
				malformedBranch,
			);
		}).not.toThrow();
		expect(result!).toBeUndefined();
	});

	it("projects only the prepared and latest meaningful user fallback candidates", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		for (let index = 0; index < 4; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: `later request ${index}`,
				timestamp: 4 + index,
			});
		}
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		let projectionCount = 0;
		const observedBranch = new Proxy(branchEntries, {
			get(target, property, receiver) {
				if (property === Symbol.iterator) {
					return function* () {
						projectionCount++;
						yield* target;
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});

		expect(
			createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: branchEntries[0].id },
				preparation.settings.reserveTokens + 1,
				"summarization-timeout",
				{},
				observedBranch,
			),
		).toBeUndefined();
		expect(projectionCount).toBe(1);
	});

	it("rejects retained context that clears the configured reserve but not the scaled hard-limit reserve", () => {
		// given a 1M window where the configured 16384 reserve scales to 40000 for the hard-limit valve
		const contextWindow = 1_000_000;
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.sessionManager.appendMessage({
			role: "user",
			content: `bulk retained context ${"filler ".repeat(139_000)}`,
			timestamp: 4,
		});
		const branchEntries = harness.sessionManager.getBranch();
		const basePreparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		const settings = { ...basePreparation.settings, reserveTokens: 16_384 };
		const preparation = { ...basePreparation, settings, firstKeptEntryId: branchEntries.at(-1)?.id ?? "" };
		const effectiveReserve = resolveCompactionGeometry({ contextWindow, settings }).reserveTokens;
		expect(settings.reserveTokens).toBe(16_384);
		expect(effectiveReserve).toBe(40_000);

		// and retained context sized into the gap between the two budgets
		const retainedTokens = createRequiredCompactionFallback(
			preparation,
			Number.MAX_SAFE_INTEGER,
			"summarization-timeout",
			{},
			branchEntries,
		)!.estimatedTokensAfter!;
		expect(retainedTokens).toBeGreaterThan(contextWindow - effectiveReserve);
		expect(retainedTokens).toBeLessThanOrEqual(contextWindow - settings.reserveTokens);

		// when the deterministic fallback projects that retained context at the 1M window
		const result = createRequiredCompactionFallback(
			preparation,
			contextWindow,
			"summarization-timeout",
			{},
			branchEntries,
		);

		// then acceptance follows the scaled hard-limit reserve and refuses the oversized suffix
		expect(result).toBeUndefined();
	});

	it("accepts the reconstructed retained context exactly at the effective reserve cap and rejects one token below", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		const retainedPreparation = { ...preparation, firstKeptEntryId: branchEntries.at(-1)?.id ?? "" };
		const roomy = createRequiredCompactionFallback(
			retainedPreparation,
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		)!;
		// The effective reserve is window-dependent, so resolve the exact cap at the window under test.
		let exactWindow = roomy.estimatedTokensAfter! + preparation.settings.reserveTokens;
		while (
			roomy.estimatedTokensAfter! >
			exactWindow -
				resolveCompactionGeometry({ contextWindow: exactWindow, settings: preparation.settings }).reserveTokens
		) {
			exactWindow++;
		}

		const exact = createRequiredCompactionFallback(
			retainedPreparation,
			exactWindow,
			"summarization-timeout",
			{},
			branchEntries,
		);
		const below = createRequiredCompactionFallback(
			retainedPreparation,
			exactWindow - 1,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(exact?.estimatedTokensAfter).toBe(roomy.estimatedTokensAfter);
		expect(below).toBeUndefined();
	});

	it("retains non-Gemini opaque provider signatures through required fallback", () => {
		for (const provider of ["openai", "anthropic"] as const) {
			const harness = createBlockingContext({ usageTokens: 9_900 });
			const assistantId = harness.sessionManager.appendMessage({
				...fauxAssistantMessage("", { timestamp: 4, stopReason: "stop" }),
				provider,
				model: provider === "openai" ? "gpt-5" : "claude-sonnet-4",
				content: [
					{
						type: "text",
						text: "retained",
						textSignature: provider === "openai" ? "legacy-id" : "opaque-anthropic",
					},
				],
			});
			const branchEntries = harness.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
			const result = createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: assistantId },
				100_000,
				"summarization-timeout",
				{},
				branchEntries,
			);
			expect(result?.firstKeptEntryId).toBe(assistantId);
		}
	});

	it("rejects malformed non-Google thinking signatures and unsigned redacted thinking", () => {
		for (const content of [
			[{ type: "thinking" as const, thinking: "hidden", thinkingSignature: 123 }],
			[{ type: "thinking" as const, thinking: "hidden", redacted: true }],
		]) {
			const harness = createBlockingContext({ usageTokens: 9_900 });
			const assistantId = harness.sessionManager.appendMessage({
				...fauxAssistantMessage("", { timestamp: 4, stopReason: "stop" }),
				provider: "anthropic",
				model: "claude-sonnet-4",
				content: content as never,
			});
			const branchEntries = harness.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

			expect(
				createRequiredCompactionFallback(
					{ ...preparation, firstKeptEntryId: assistantId },
					100_000,
					"summarization-timeout",
					{},
					branchEntries,
				),
			).toBeUndefined();
		}
	});

	it("finds a declaring assistant beyond five entries for a long tool chain", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const assistantId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 4, stopReason: "toolUse" }),
			provider: "google",
			model: "gemini-3-flash",
			content: Array.from({ length: 6 }, (_, index) => ({
				type: "toolCall" as const,
				id: `call-${index}`,
				name: "read",
				arguments: { path: `${index}.ts` },
				thoughtSignature: validSig,
			})),
		});
		for (let index = 0; index < 6; index++) {
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: `result-${index}` }],
				isError: false,
				timestamp: 5 + index,
			});
		}
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		const sixthResultId = branchEntries[branchEntries.length - 1].id;
		const result = createRequiredCompactionFallback(
			{ ...preparation, firstKeptEntryId: sixthResultId },
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);
		expect(result?.firstKeptEntryId).toBe(assistantId);
		expect(result?.details).toMatchObject({ retainedSuffix: "earlier-safe-boundary" });
	});

	it("rejects incomplete tool calls even when a matching result is retained", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const assistantId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 4, stopReason: "toolUse" }),
			provider: "google",
			model: "gemini-3-flash",
			content: [
				{
					type: "toolCall",
					id: "incomplete-call",
					name: "read",
					arguments: {},
					incomplete: true,
					thoughtSignature: validSig,
				},
			],
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "incomplete-call",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 5,
		});
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

		expect(
			createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: assistantId },
				100_000,
				"summarization-timeout",
				{},
				branchEntries,
			),
		).toBeUndefined();
	});

	it("keeps fallback candidate scanning linear for a 10,000-entry malformed history", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		for (let index = 0; index < 10_000; index++) {
			harness.sessionManager.appendMessage({ role: "user", content: `history-${index}`, timestamp: index + 4 });
		}
		const malformedBoundary = harness.sessionManager.appendMessage({
			...createGeminiAssistantMessage([{ type: "text", text: "retained", textSignature: "not-base64" }], {
				timestamp: 20_000,
				stopReason: "stop",
			}),
		});
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		const startedAt = performance.now();
		const result = createRequiredCompactionFallback(
			{ ...preparation, firstKeptEntryId: malformedBoundary },
			100_000_000,
			"summarization-timeout",
			{},
			branchEntries,
		);
		const elapsedMs = performance.now() - startedAt;

		expect(result).toBeUndefined();
		expect(elapsedMs).toBeLessThan(10_000);
	});

	it("rejects a tool call whose only result precedes it", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "reversed",
			toolName: "read",
			content: [{ type: "text", text: "stale result" }],
			isError: false,
			timestamp: 4,
		});
		const assistantId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{ type: "toolCall", id: "reversed", name: "read", arguments: {}, thoughtSignature: validSig },
			]),
		);
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

		expect(
			createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: assistantId },
				100_000,
				"summarization-timeout",
				{},
				branchEntries,
			),
		).toBeUndefined();
	});

	it("rejects reversed-order incomplete tool calls instead of retaining them", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "reversed-incomplete",
			toolName: "read",
			content: [{ type: "text", text: "stale result" }],
			isError: false,
			timestamp: 4,
		});
		const assistantId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{
					type: "toolCall",
					id: "reversed-incomplete",
					name: "read",
					arguments: {},
					thoughtSignature: validSig,
					incomplete: true,
				},
			]),
		);
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

		expect(
			createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: assistantId },
				100_000,
				"summarization-timeout",
				{},
				branchEntries,
			),
		).toBeUndefined();
	});

	it("rejects duplicate tool results instead of replaying them", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const assistantId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 4, stopReason: "toolUse" }),
			provider: "google",
			model: "gemini-3-flash",
			content: [{ type: "toolCall", id: "duplicate", name: "read", arguments: {}, thoughtSignature: validSig }],
		});
		for (let index = 0; index < 2; index++) {
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "duplicate",
				toolName: "read",
				content: [{ type: "text", text: `result-${index}` }],
				isError: false,
				timestamp: 5 + index,
			});
		}
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		expect(
			createRequiredCompactionFallback(
				{ ...preparation, firstKeptEntryId: assistantId },
				100_000,
				"summarization-timeout",
				{},
				branchEntries,
			),
		).toBeUndefined();
	});

	it("rejects accessor-bearing retained tool-call arguments without executing them", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		const boundary = branchEntries.at(-1)!;

		let getterCalls = 0;
		const argumentsWithAccessor = {};
		Object.defineProperty(argumentsWithAccessor, "payload", {
			enumerable: true,
			get() {
				getterCalls++;
				return "x".repeat(1_024);
			},
		});
		const toolMessage = {
			...fauxAssistantMessage("", { timestamp: 4, stopReason: "toolUse" }),
			content: [{ type: "toolCall" as const, id: "probe", name: "probe", arguments: argumentsWithAccessor }],
		};
		const observedBranch = branchEntries.map((entry) =>
			entry.id === boundary.id ? { ...entry, message: toolMessage } : entry,
		);

		const result = createRequiredCompactionFallback(
			{ ...preparation, firstKeptEntryId: boundary.id },
			100_000,
			"summarization-timeout",
			{},
			observedBranch,
		);

		expect(result).toBeUndefined();
		expect(getterCalls).toBe(0);
	});
});

describe("deterministic compaction fallback Gemini signed state and recovery cases", () => {
	it("Case A: required fallback replays Gemini signed state through the handler and Google converter", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.registration.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream_stream_truncated: stream ended" }),
		]);
		const preparedBoundaryId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "foo.ts" },
					thoughtSignature: validSig,
				},
			]),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: 5,
		});

		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				requestId: "gemini-signed-fallback",
				preparation: { ...preparation!, firstKeptEntryId: preparedBoundaryId },
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);
		const compaction = result?.compaction;
		expect(compaction).toBeDefined();
		if (!compaction) throw new Error("Expected fallback compaction");
		expect(compaction).toMatchObject({
			firstKeptEntryId: preparedBoundaryId,
			details: { retainedSuffix: "prepared" },
		});

		harness.sessionManager.appendCompaction(
			compaction.summary,
			compaction.firstKeptEntryId,
			compaction.tokensBefore,
			compaction.details,
			true,
		);

		const messages = harness.sessionManager.buildSessionContext().messages;
		const googleModel: Model<"google-generative-ai"> = {
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			provider: "google",
			api: "google-generative-ai",
			baseUrl: "https://generativelanguage.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 16_000,
		};
		const replayMessages = messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
		const contents = convertGoogleMessages(googleModel, { messages: replayMessages });
		expect(contents.some((content) => content.parts?.some((part) => "functionCall" in part))).toBe(true);
		const assistantMsg = messages.find((m) => m.role === "assistant") as AssistantMessage | undefined;
		expect(assistantMsg).toBeDefined();
		const firstBlock = assistantMsg?.content[0];
		if (firstBlock?.type === "toolCall") {
			expect(firstBlock.thoughtSignature).toBe(validSig);
		} else {
			throw new Error("Expected toolCall block");
		}
	});

	it("Case B: preserves empty signed text and thinking parts without discarding them", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparedBoundaryId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: validSig,
				},
				{
					type: "text",
					text: "",
					textSignature: validSig,
				},
				{
					type: "toolCall",
					id: "call-empty-text",
					name: "read",
					arguments: { path: "bar.ts" },
					thoughtSignature: validSig,
				},
			]),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-empty-text",
			toolName: "read",
			content: [{ type: "text", text: "bar content" }],
			isError: false,
			timestamp: 5,
		});

		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = createRequiredCompactionFallback(
			{ ...preparation!, firstKeptEntryId: preparedBoundaryId },
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toBeDefined();
		expect(result?.firstKeptEntryId).toBe(preparedBoundaryId);
	});

	it("Case C: handles sequential function calling chain without invalid cut", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const startId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{
					type: "toolCall",
					id: "call-seq-1",
					name: "read",
					arguments: { path: "a.ts" },
					thoughtSignature: validSig,
				},
			]),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-seq-1",
			toolName: "read",
			content: [{ type: "text", text: "a content" }],
			isError: false,
			timestamp: 5,
		});
		harness.sessionManager.appendMessage(
			createGeminiAssistantMessage(
				[
					{
						type: "toolCall",
						id: "call-seq-2",
						name: "read",
						arguments: { path: "b.ts" },
						thoughtSignature: validSig,
					},
				],
				{ timestamp: 6 },
			),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-seq-2",
			toolName: "read",
			content: [{ type: "text", text: "b content" }],
			isError: false,
			timestamp: 7,
		});

		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = createRequiredCompactionFallback(
			{ ...preparation!, firstKeptEntryId: startId },
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toBeDefined();
		expect(result?.firstKeptEntryId).toBe(startId);
	});

	it("Case D: attempts earlier safe boundary when boundary would cut through tool call chain", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const assistantId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{
					type: "toolCall",
					id: "call-split",
					name: "read",
					arguments: { path: "split.ts" },
					thoughtSignature: validSig,
				},
			]),
		);
		const resultId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-split",
			toolName: "read",
			content: [{ type: "text", text: "split content" }],
			isError: false,
			timestamp: 5,
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: "follow up request",
			timestamp: 6,
		});

		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);

		// If initial boundary was positioned at resultId (cutting tool call),
		// it must find the earlier safe boundary at assistantId
		const result = createRequiredCompactionFallback(
			{ ...preparation!, firstKeptEntryId: resultId },
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toBeDefined();
		if (!result?.details) throw new Error("Expected fallback result with details");
		expect(result.firstKeptEntryId).toBe(assistantId);
		expect(result.details.retainedSuffix).toBe("earlier-safe-boundary");
	});

	it("Case E: fails closed on genuinely unsafe / malformed provider signatures", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const badSigId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{
					type: "toolCall",
					id: "call-bad-sig",
					name: "read",
					arguments: { path: "bad.ts" },
					thoughtSignature: "not!base64!valid!sig", // Invalid base64 characters
				},
			]),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-bad-sig",
			toolName: "read",
			content: [{ type: "text", text: "bad content" }],
			isError: false,
			timestamp: 5,
		});

		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);

		const result = createRequiredCompactionFallback(
			{ ...preparation!, firstKeptEntryId: badSigId },
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toBeUndefined();
	});

	it("Case F: budget exhaustion cleanly rejects without unbounded boundary search", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparedBoundaryId = harness.sessionManager.appendMessage(
			createGeminiAssistantMessage([
				{
					type: "toolCall",
					id: "call-huge",
					name: "read",
					arguments: { path: "huge.ts" },
					thoughtSignature: validSig,
				},
			]),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-huge",
			toolName: "read",
			content: [{ type: "text", text: "huge tool result ".repeat(500) }],
			isError: false,
			timestamp: 5,
		});

		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);

		const diagnostics: { rejectionReason?: string; budgetExceeded?: boolean } = {};
		const result = createRequiredCompactionFallback(
			{ ...preparation!, firstKeptEntryId: preparedBoundaryId },
			100, // Tiny context window -> budget exceeded
			"summarization-timeout",
			{},
			branchEntries,
			diagnostics as never,
		);

		expect(result).toBeUndefined();
		expect(diagnostics.rejectionReason).toBe("retained-token-budget-exceeded");
		expect(diagnostics.budgetExceeded).toBe(true);
	});

	it("Case G: cross-model handoff transforms Gemini signed state correctly without replaying invalid signatures", () => {
		const geminiAssistant = createGeminiAssistantMessage([
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "foo.ts" },
				thoughtSignature: validSig,
			},
		]);
		const toolRes = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "result" }],
			isError: false,
			timestamp: 5,
		};

		// Transforming to Anthropic target model
		const targetModel: Model<"anthropic-messages"> = {
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_000,
		};

		const transformed = transformMessages([geminiAssistant, toolRes], targetModel);
		const transformedAssistant = transformed.find((m) => m.role === "assistant") as AssistantMessage | undefined;
		expect(transformedAssistant).toBeDefined();
		const block = transformedAssistant?.content[0];
		if (block?.type === "toolCall") {
			expect(block.thoughtSignature).toBeUndefined();
		} else {
			throw new Error("Expected toolCall block");
		}
	});
});
