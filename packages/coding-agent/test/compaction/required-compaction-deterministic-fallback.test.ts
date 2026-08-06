import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import { StreamDurationBudgetError } from "../../src/core/compaction/stream-watchdog.ts";
import {
	classifyRequiredCompactionFallbackFailure,
	createRequiredCompactionFallback,
} from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { SummaryRequestError } from "../../src/core/extensions/builtin/compaction/speculative.ts";
import type { CompactionReason } from "../../src/core/extensions/types.ts";
import { createBlockingContext, createCompactionHandlers } from "../helpers/blocking-compaction-harness.ts";

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

	it("retains a signature-bearing prepared suffix", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparedBoundaryId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 4, stopReason: "toolUse" }),
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig" },
				{ type: "text", text: "calling a tool", textSignature: "sig" },
				{
					type: "toolCall",
					id: "signed-tool",
					name: "read",
					arguments: { path: "README.md" },
					thoughtSignature: "sig",
				},
			],
		} as never);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "signed-tool",
			toolName: "read",
			content: [{ type: "text", text: "signed result" }],
			isError: false,
			timestamp: 5,
		});
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

		const result = createRequiredCompactionFallback(
			{ ...preparation, firstKeptEntryId: preparedBoundaryId },
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toMatchObject({
			firstKeptEntryId: preparedBoundaryId,
			details: { retainedSuffix: "prepared" },
		});
	});

	it("accepts redacted thinking in the prepared suffix", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparedBoundaryId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 4 }),
			content: [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }],
		} as never);
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

		const result = createRequiredCompactionFallback(
			{ ...preparation, firstKeptEntryId: preparedBoundaryId },
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toMatchObject({
			firstKeptEntryId: preparedBoundaryId,
			details: { retainedSuffix: "prepared" },
		});
	});

	it("rejects redacted thinking without a non-empty encrypted payload", () => {
		for (const content of [
			[{ type: "thinking", thinking: "", redacted: true }],
			[{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "" }],
		]) {
			const harness = createBlockingContext({ usageTokens: 9_900 });
			const malformedBoundaryId = harness.sessionManager.appendMessage({
				...fauxAssistantMessage("", { timestamp: 4 }),
				content,
			} as never);
			const branchEntries = harness.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

			expect(
				createRequiredCompactionFallback(
					{ ...preparation, firstKeptEntryId: malformedBoundaryId },
					100_000,
					"summarization-timeout",
					{},
					branchEntries,
				),
			).toBeUndefined();
		}
	});

	it("rejects non-string replay signatures", () => {
		for (const content of [
			[{ type: "thinking", thinking: "reasoning", thinkingSignature: 42 }],
			[{ type: "text", text: "answer", textSignature: 42 }],
		]) {
			const harness = createBlockingContext({ usageTokens: 9_900 });
			const malformedBoundaryId = harness.sessionManager.appendMessage({
				...fauxAssistantMessage("", { timestamp: 4 }),
				content,
			} as never);
			const branchEntries = harness.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

			expect(
				createRequiredCompactionFallback(
					{ ...preparation, firstKeptEntryId: malformedBoundaryId },
					100_000,
					"summarization-timeout",
					{},
					branchEntries,
				),
			).toBeUndefined();
		}
	});

	it("recovers an autonomous tail through the latest custom turn boundary", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparedBoundaryId = harness.sessionManager.appendMessage(
			fauxAssistantMessage("oversized prepared suffix ".repeat(2_000), { timestamp: 4 }),
		);
		harness.sessionManager.appendCustomMessageEntry("goal-progress", "first autonomous turn", false);
		harness.sessionManager.appendMessage(fauxAssistantMessage("intermediate work", { timestamp: 5 }));
		const latestCustomId = harness.sessionManager.appendCustomMessageEntry(
			"goal-continuation",
			"continue autonomous goal",
			false,
		);
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 6, stopReason: "toolUse" }),
			content: [{ type: "toolCall", id: "autonomous-tool", name: "read", arguments: { path: "TODO.md" } }],
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "autonomous-tool",
			toolName: "read",
			content: [{ type: "text", text: "autonomous result" }],
			isError: false,
			timestamp: 7,
		});
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

		const result = createRequiredCompactionFallback(
			{ ...preparation, firstKeptEntryId: preparedBoundaryId },
			4_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toMatchObject({
			firstKeptEntryId: latestCustomId,
			details: { retainedSuffix: "latest-turn-start" },
		});
	});

	it("degrades to the latest assistant cut point and retains its tool results", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparedBoundaryId = harness.sessionManager.appendMessage(
			fauxAssistantMessage("oversized prepared suffix ".repeat(2_000), { timestamp: 4 }),
		);
		const assistantBoundaryId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { timestamp: 5, stopReason: "toolUse" }),
			content: [{ type: "toolCall", id: "tail-tool", name: "read", arguments: { path: "README.md" } }],
		});
		const toolResultId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tail-tool",
			toolName: "read",
			content: [{ type: "text", text: "trailing tool result" }],
			isError: false,
			timestamp: 6,
		});
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;

		const result = createRequiredCompactionFallback(
			{ ...preparation, firstKeptEntryId: preparedBoundaryId },
			4_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toMatchObject({
			firstKeptEntryId: assistantBoundaryId,
			details: { retainedSuffix: "latest-cut-point" },
		});
		expect(result?.firstKeptEntryId).not.toBe(toolResultId);
		if (!result) throw new Error("Expected deterministic cut-point recovery");
		harness.sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			true,
		);
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toContain("trailing tool result");
	});

	it("does not recover manual, aborted, or unrelated failures", async () => {
		for (const testCase of [
			{ reason: "manual" as const, message: "upstream_stream_truncated", aborted: false, refusal: false },
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
			expect(result).toMatchObject({ cancel: true });
			expect(result).not.toHaveProperty("compaction");
		}
	});

	it("fails closed for every non-required reason even when typed truncation recovery would fit", async () => {
		const nonRequiredReasons = ["manual", "pre_prompt", "branch", "extension"] satisfies CompactionReason[];
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
		expect(result!.summary).not.toContain("�");
		expect(result!.summary).toContain("Finish the current repair");
		expect(result!.summary).toContain("Previous checkpoint:");
		expect(result!.summary).toContain("[Older checkpoint truncated]");
		expect(Buffer.byteLength(result!.summary)).toBeLessThanOrEqual(40_000);
		expect(result!.summary).not.toContain("verify recovery");
		expect(result!.summary).not.toContain("agent-session.ts");
		expect(result!.details).toEqual({
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

	it("deduplicates overlapping fallback ladder boundaries", () => {
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
		expect(projectionCount).toBe(2);
	});

	it("accepts the reconstructed retained context exactly at the input cap and rejects one token below", () => {
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
		const exactWindow = roomy.estimatedTokensAfter! + preparation.settings.reserveTokens;

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
