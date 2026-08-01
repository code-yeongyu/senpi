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
	it("cancels when the prepared suffix cannot fit without dropping the latest request", async () => {
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

		expect(result).toMatchObject({
			cancel: true,
			reason: "deterministic compaction fallback cannot retain the prepared suffix",
		});
		expect(result).not.toHaveProperty("compaction");
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toContain("Keep latest request");
		expect(harness.registration.getCallLog()).toHaveLength(1);
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

	it("preserves current todo state when the first required automatic summary times out", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = createRequiredCompactionFallback(
			{
				...preparation!,
				firstKeptEntryId: branchEntries.at(-1)?.id ?? "",
			},
			100_000,
			"summarization-timeout",
			{
				todoSnapshot: {
					schema: "senpi.compaction.todo-snapshot.v1",
					todos: [
						{
							name: "Repair",
							tasks: [
								{ content: "Preserve automatic compaction task state", status: "in_progress" },
								{ content: "Run automatic compaction regression", status: "pending" },
							],
						},
					],
					capturedAt: 0,
				},
			},
			branchEntries,
		);

		expect(result).toBeDefined();
		expect(result!.summary).toContain("Current todo state:");
		expect(result!.summary).toContain("[in_progress] Preserve automatic compaction task state");
		expect(result!.summary).toContain("[pending] Run automatic compaction regression");
		expect(result!.details).not.toHaveProperty("todoSnapshot");
	});

	it("passes the latest todo snapshot through the required automatic fallback handler", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 99_000, contextWindow: 100_000 });
		harness.sessionManager.appendCustomEntry("senpi.todo-state", {
			schema: "v2",
			phases: [{ name: "Old", tasks: [{ content: "Do not restore obsolete work", status: "in_progress" }] }],
		});
		harness.sessionManager.appendCustomEntry("senpi.todo-state", {
			schema: "v2",
			phases: [
				{
					name: "Current",
					tasks: [{ content: "Restore the current automatic compaction task", status: "in_progress" }],
				},
			],
		});
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
				requestId: "automatic-fallback-with-current-todos",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		expect(result).toHaveProperty("compaction");
		expect(result?.compaction?.summary).toContain("[in_progress] Restore the current automatic compaction task");
		expect(result?.compaction?.summary).not.toContain("Do not restore obsolete work");
	});

	it("preserves recent dropped user intent when automatic fallback has no todo state", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();
		branchEntries.splice(-1, 0, {
			type: "message",
			id: "control-envelope",
			parentId: branchEntries.at(-2)?.id ?? null,
			timestamp: new Date(4).toISOString(),
			message: {
				role: "user",
				content: [
					{ type: "text", text: "<system-reminder>Do not preserve this control envelope</system-reminder>" },
				],
				timestamp: 4,
			},
		});

		const result = createRequiredCompactionFallback(
			{
				...preparation!,
				firstKeptEntryId: branchEntries.at(-1)?.id ?? "",
			},
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(result).toBeDefined();
		expect(result!.summary).toContain("Task intent:");
		expect(result!.summary).toContain("Summarize old context");
		expect(result!.summary).not.toContain("Do not preserve this control envelope");
	});

	it("requires a real retained suffix, keeps only canonical detail metadata, and uses UTF-8-safe bounds", () => {
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
				taskIntent: `Finish the current repair\n${"😀".repeat(3_000)}PRIVATE_TAIL`,
				todoSnapshot: { items: ["verify recovery"] },
				checkpoint: { files: ["agent-session.ts"] },
			},
			branchEntries,
		);

		expect(result).toBeDefined();
		expect(result!.summary).not.toContain("�");
		expect(result!.summary).not.toContain("PRIVATE_TAIL");
		expect(result!.details).toMatchObject({
			retainedSuffix: "prepared",
		});
		expect(result!.details).not.toHaveProperty("taskIntent");
		expect(result!.details).not.toHaveProperty("todoSnapshot");
		expect(result!.details).not.toHaveProperty("checkpoint");
		harness.sessionManager.appendCompaction(
			result!.summary,
			result!.firstKeptEntryId,
			result!.tokensBefore,
			result!.details,
			true,
		);
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toContain("Keep latest request");
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
});
