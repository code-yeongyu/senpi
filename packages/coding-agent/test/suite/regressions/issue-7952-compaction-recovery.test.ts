import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, prepareCompaction } from "../../../src/core/compaction/index.ts";
import {
	createRequiredCompactionFallback,
	type DeterministicFallbackDiagnostic,
} from "../../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { createSpeculativeCompactionSnapshot } from "../../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../../helpers/blocking-compaction-harness.ts";

const settings = {
	...DEFAULT_COMPACTION_SETTINGS,
	reserveTokens: 100,
	reserveScalingEnabled: false,
	keepRecentTokens: 1000,
};

function appendCall(manager: SessionManager, id: string) {
	return manager.appendMessage({
		...fauxAssistantMessage("", { timestamp: 2, stopReason: "toolUse" }),
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "fixture.txt" } }],
	});
}

function appendResult(manager: SessionManager, id: string, text: string) {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	});
}

function recover(manager: SessionManager, boundary: string, window: number, previousSummary?: string) {
	const branch = manager.getBranch();
	const preparation = prepareCompaction(branch, settings, true);
	if (!preparation) throw new Error("Fixture needs a compaction preparation");
	const diagnostics: DeterministicFallbackDiagnostic = {};
	const result = createRequiredCompactionFallback(
		{ ...preparation, firstKeptEntryId: boundary, previousSummary },
		window,
		"summarization-timeout",
		{},
		branch,
		diagnostics,
	);
	return { result, diagnostics };
}

describe("issue #7952: fitting suffix recovery", () => {
	it.each([
		{ reason: "manual" as const, overBudget: false },
		{ reason: "threshold" as const, overBudget: false },
		{ reason: "manual" as const, overBudget: true },
		{ reason: "threshold" as const, overBudget: true },
	])("consumes a failed core-route warm job ($reason, overBudget=$overBudget)", async ({ reason, overBudget }) => {
		// Given: a matching warm summary already failed on this unchanged branch.
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		if (overBudget) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: "oversized input ".repeat(4_000),
				timestamp: 4,
			});
		}
		const snapshot = createSpeculativeCompactionSnapshot(harness.ctx, { generation: 1, origin: "speculative" });
		if (!snapshot) throw new Error("Fixture needs a speculative snapshot");
		harness.registration.setResponses([fauxAssistantMessage("")]);
		try {
			await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
			await handlers.waitForSpeculativeJob();

			// When: the core/manual hook claims the failed warm job.
			const result = await handlers.sessionBeforeCompact(
				{
					type: "session_before_compact",
					reason,
					willRetry: false,
					requestId: "7952-core-warm",
					preparation: snapshot.preparation,
					branchEntries: harness.sessionManager.getBranch(),
					signal: new AbortController().signal,
				},
				harness.ctx,
			);

			// Then: it recovers or diagnoses without another provider request.
			expect(harness.registration.getCallLog()).toHaveLength(1);
			if (overBudget) {
				expect(result?.cancel).toBe(true);
				expect(JSON.parse(result?.reason?.split("\n")[1] ?? "{}")).toMatchObject({
					rejectionReason: "retained-token-budget-exceeded",
				});
			} else {
				expect(result?.compaction?.details).toMatchObject({
					origin: "required-compaction-recovery",
					failureKind: "summarization-empty-summary",
				});
			}
		} finally {
			harness.registration.unregister();
		}
	});

	it("reports an impossible blocking recovery without applying a checkpoint", async () => {
		// Given: the latest user turn alone exceeds the effective context budget.
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_950 });
		harness.sessionManager.appendMessage({
			role: "user",
			content: "oversized input ".repeat(4_000),
			timestamp: 4,
		});
		harness.registration.setResponses([fauxAssistantMessage("")]);
		try {
			// When: automatic blocking compaction cannot retain any safe fitting suffix.
			await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

			// Then: it ends visibly with the same structured budget diagnosis.
			expect(harness.ctx.applyCompaction).not.toHaveBeenCalled();
			const errorMessage = harness.endCompaction.mock.calls.at(-1)?.[0]?.errorMessage;
			expect(errorMessage).toBeDefined();
			expect(JSON.parse(errorMessage?.split("\n")[1] ?? "{}")).toMatchObject({
				rejectionReason: "retained-token-budget-exceeded",
				budgetTokens: 9_600,
			});
		} finally {
			harness.registration.unregister();
		}
	});

	it.each([false, true])("recovers blocking compaction after a classified failure (warm=%s)", async (warm) => {
		// Given: either a fresh summarization or an already-failed speculative job.
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: warm ? 4_000 : 9_950, graceBandEnabled: false });
		harness.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: Responses stream ended before a terminal event",
			}),
		]);
		try {
			if (warm) {
				await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
				await handlers.waitForSpeculativeJob();
				harness.setUsageTokens(9_950);
			}

			// When: a blocking compaction is required by the next prompt.
			await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);

			// Then: deterministic recovery uses the failed attempt, not another billed request.
			expect(harness.registration.getCallLog()).toHaveLength(1);
			expect(harness.ctx.applyCompaction).toHaveBeenCalledWith(
				expect.objectContaining({
					details: expect.objectContaining({
						origin: "required-compaction-recovery",
						failureKind: "upstream-stream-truncated",
					}),
				}),
				expect.objectContaining({ reason: "extension" }),
			);
		} finally {
			harness.registration.unregister();
		}
	});

	it("retains a 136k-token tool result even when its storage exceeds the window", () => {
		// Given: the report's latest-turn geometry, with a complete tool pair.
		const manager = SessionManager.inMemory();
		const boundary = manager.appendMessage({ role: "user", content: "Keep this request", timestamp: 1 });
		appendCall(manager, "read-1");
		appendResult(manager, "read-1", "ordinary prose ".repeat(36_200));
		const original = JSON.stringify(manager.getBranch());
		const tokens = manager.buildSessionContext().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		expect(tokens).toBeGreaterThan(135_000);
		expect(tokens).toBeLessThan(137_000);
		expect(original.length).toBeGreaterThan(400_000);

		// When: the provider summarizer failed but this suffix fits its token window.
		const { result } = recover(manager, boundary, 400_000);

		// Then: no retained message is sacrificed to a storage-byte accounting error.
		expect(result).toMatchObject({ firstKeptEntryId: boundary, details: { retainedSuffix: "prepared" } });
		expect(result?.estimatedTokensAfter).toBeLessThan(140_000);
		expect(JSON.stringify(manager.getBranch())).toBe(original);
	});

	it("counts the checkpoint in token units as well as the retained suffix", () => {
		// Given: prose and an older checkpoint together fit a 10k-token window.
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Previous request", timestamp: 0 });
		manager.appendMessage(fauxAssistantMessage("Previous response", { timestamp: 0 }));
		const boundary = manager.appendMessage({ role: "user", content: "word ".repeat(6_400), timestamp: 1 });

		// When: recovery carries a bounded prior checkpoint.
		const { result } = recover(manager, boundary, 10_000, "checkpoint ".repeat(300));

		// Then: both estimates use tokens, not serialized bytes.
		expect(result?.firstKeptEntryId).toBe(boundary);
		expect(result?.estimatedTokensAfter).toBeLessThan(9_500);
	});

	it("backtracks from the latest user to a fitting declaring assistant", () => {
		// Given: prepared history is too large; the latest user interrupts a tool pair.
		const manager = SessionManager.inMemory();
		const prepared = manager.appendMessage({ role: "user", content: "old ".repeat(20_000), timestamp: 1 });
		const safeBoundary = appendCall(manager, "read-1");
		manager.appendMessage({ role: "user", content: "Keep this steering request", timestamp: 2 });
		appendResult(manager, "read-1", "result");

		// When: the latest-user boundary alone would orphan that result.
		const { result } = recover(manager, prepared, 10_000);

		// Then: its complete pair is retained without losing the latest request.
		expect(result?.firstKeptEntryId).toBe(safeBoundary);
	});

	it("ignores repeated tool IDs entirely outside the retained suffix", () => {
		// Given: separate historical turns reused an ID; only the newest pair is kept.
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Old request", timestamp: 1 });
		appendCall(manager, "reused");
		appendResult(manager, "reused", "old result");
		const boundary = manager.appendMessage({ role: "user", content: "New request", timestamp: 4 });
		appendCall(manager, "reused");
		appendResult(manager, "reused", "new result");

		// When: recovery projects the newest turn.
		const { result } = recover(manager, boundary, 10_000);

		// Then: discarded history cannot invalidate an internally unique pair.
		expect(result?.firstKeptEntryId).toBe(boundary);
	});

	it.each(["threshold", "manual"] as const)("reports %s budget rejection", async (reason) => {
		// Given: even the latest user turn genuinely exceeds the effective budget.
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 40_000 });
		const boundary = harness.sessionManager.appendMessage({
			role: "user",
			content: "large retained input ".repeat(4_000),
			timestamp: 4,
		});
		harness.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: Responses stream ended before a terminal event",
			}),
		]);
		const branchEntries = harness.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		if (!preparation) throw new Error("Fixture needs preparation");

		// When: required fallback rejects every candidate.
		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason,
				willRetry: false,
				requestId: `7952-${reason}`,
				preparation: { ...preparation, firstKeptEntryId: boundary },
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		// Then: the rejection contains a machine-readable, payload-free budget diagnostic.
		expect(result?.cancel).toBe(true);
		const diagnosticLine = result?.reason?.split("\n")[1];
		expect(diagnosticLine).toBeDefined();
		const diagnostic = JSON.parse(diagnosticLine ?? "{}");
		expect(diagnostic).toMatchObject({
			rejectionReason: "retained-token-budget-exceeded",
			contextWindow: 10_000,
			reserveTokens: 400,
			budgetTokens: 9_600,
			budgetExceeded: true,
		});
		expect(diagnostic.candidate.estimatedTokens).toBeGreaterThan(diagnostic.budgetTokens);
		expect(result?.reason).not.toContain("large retained input");
	});
});
