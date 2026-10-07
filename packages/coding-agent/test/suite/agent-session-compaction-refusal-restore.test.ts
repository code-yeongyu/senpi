import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

function refusal(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(text, {
		stopReason: "error",
		errorMessage: "misleading_success_output",
		stopDetails: { type: "refusal" },
	});
}

// Verbatim provider error captured from a real session (2026-07-28, anthropic-api
// claude-fable-5): the billing class whose pins compaction must never release.
const creditBalanceError =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CdUDPLwbT8EDXCxMJBvQy"}';

const billingError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: creditBalanceError });

interface FallbackStateView {
	pinned: boolean;
	pinnedByRefusal: boolean;
	pinnedByBilling: boolean;
}

interface ControllerApi {
	activeState: Readonly<FallbackStateView> | undefined;
	notifyCompactionApplied(): boolean;
}

interface SessionRestoreSeam {
	_maybeRestoreFallbackPrimary(): Promise<void>;
}

function controller(harness: Harness): ControllerApi {
	return (harness.session as unknown as { _retryFallback: ControllerApi })._retryFallback;
}

function fallbackState(harness: Harness): FallbackStateView | undefined {
	return controller(harness).activeState;
}

function restoreSeam(harness: Harness): SessionRestoreSeam {
	return harness.session as unknown as SessionRestoreSeam;
}

function refusalReleaseLines(harness: Harness): string[] {
	try {
		return readFileSync(join(harness.tempDir, "agent", "logs", "fallback.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.filter((line) => line.includes('"event":"refusal_pin_released"'));
	} catch {
		return [];
	}
}

function createPrecomputedCompaction(harness: Harness, summary: string): CompactionResult {
	const firstEntry = harness.sessionManager.getEntries()[0];
	if (!firstEntry) {
		throw new Error("Expected at least one session entry");
	}

	return {
		summary,
		firstKeptEntryId: firstEntry.id,
		tokensBefore: 42,
		details: { source: "test" },
	};
}

function compactionEntries(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

describe("agent-session compaction refusal unpin + eager restore", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("(1) restores the refusal-pinned primary eagerly after a successful compaction apply", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 128_000 },
				{ id: "faux-2", contextWindow: 128_000 },
			],
			fallbackNow: () => 0,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: true, pinnedByBilling: false });

		const expectedRevision = harness.session.getMessageRevision();
		const result = await harness.session.applyCompaction(createPrecomputedCompaction(harness, "fresh summary"), {
			reason: "extension",
			expectedRevision,
		});
		expect(result).toEqual({ applied: true, reason: "ok" });
		expect(compactionEntries(harness)).toBe(1);

		// The restore is eager: the primary is selected before the next request is
		// built (no extra provider call happened for the switch itself).
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(fallbackState(harness)).toBeUndefined();

		const reverted = harness.eventsOfType("retry_fallback_reverted");
		expect(reverted).toMatchObject([{ from: fallback, to: primary }]);
		const types = harness.events.map((event) => event.type);
		expect(types.indexOf("retry_fallback_reverted")).toBeGreaterThan(types.lastIndexOf("compaction_end"));

		// The turn-boundary / retry-continuation restore seam is a no-op after the
		// eager restore: state is cleared, so no second switchModel can occur.
		const callsBeforeSecondRestore = harness.faux.getCallLog().length;
		await restoreSeam(harness)._maybeRestoreFallbackPrimary();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.faux.getCallLog().length).toBe(callsBeforeSecondRestore);
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(1);
	});

	it("(2) keeps the refusal pin when the compaction apply fails or is rejected", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 128_000 },
				{ id: "faux-2", contextWindow: 128_000 },
			],
			fallbackNow: () => 0,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		expect(harness.session.model?.id).toBe("faux-2");
		const expectedRevision = harness.session.getMessageRevision();

		// Stale revision: rejected before any context rewrite.
		const oversized = createPrecomputedCompaction(harness, "overflow".repeat(1_000_000));
		const stale = await harness.session.applyCompaction(oversized, {
			reason: "extension",
			expectedRevision: expectedRevision + 1,
		});
		expect(stale).toEqual({ applied: false, reason: "stale" });

		// Would-overflow: the execution seam itself rejects with an errorMessage.
		const rejected = await harness.session.applyCompaction(oversized, {
			reason: "extension",
			expectedRevision,
		});
		expect(rejected).toEqual({ applied: false, reason: "rejected" });
		const failureEnds = harness.eventsOfType("compaction_end").filter((event) => event.errorMessage !== undefined);
		expect(failureEnds.length).toBeGreaterThanOrEqual(1);
		expect(compactionEntries(harness)).toBe(0);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: true, pinnedByBilling: false });
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(refusalReleaseLines(harness)).toHaveLength(0);
	});

	it("(3) holds a billing fallback across a successful compaction apply", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 128_000 },
				{ id: "faux-2", contextWindow: 128_000 },
			],
			fallbackNow: () => 0,
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([billingError(), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.reason)).toEqual(["billing"]);
		expect(harness.session.model?.id).toBe("faux-2");

		const result = await harness.session.applyCompaction(createPrecomputedCompaction(harness, "billing stays"), {
			reason: "extension",
			expectedRevision: harness.session.getMessageRevision(),
		});
		expect(result).toEqual({ applied: true, reason: "ok" });
		expect(compactionEntries(harness)).toBe(1);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: false, pinnedByBilling: true });
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(refusalReleaseLines(harness)).toHaveLength(0);
	});

	it('(4) unpins under revertPolicy "never" but never restores', async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 128_000 },
				{ id: "faux-2", contextWindow: 128_000 },
			],
			fallbackNow: () => 0,
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
					fallbackRevertPolicy: "never",
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		expect(harness.session.model?.id).toBe("faux-2");

		const result = await harness.session.applyCompaction(createPrecomputedCompaction(harness, "never summary"), {
			reason: "extension",
			expectedRevision: harness.session.getMessageRevision(),
		});
		expect(result).toEqual({ applied: true, reason: "ok" });

		// The unpin ran through the seam, but the policy holds the fallback model.
		expect(fallbackState(harness)).toMatchObject({ pinned: false, pinnedByRefusal: false, pinnedByBilling: false });
		expect(refusalReleaseLines(harness)).toHaveLength(1);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);

		harness.setResponses([fauxAssistantMessage("fallback again")]);
		await harness.session.prompt("second");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.faux.getCallLog()[2]?.modelId).toBe("faux-2");
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
	});

	it("(5) re-pins when the restored primary refuses again (one attempt per compaction)", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 128_000 },
				{ id: "faux-2", contextWindow: 128_000 },
			],
			fallbackNow: () => 0,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			refusal("primary refusal"),
			fauxAssistantMessage("fallback answer"),
			refusal("primary refusal again"),
			fauxAssistantMessage("fallback answer again"),
		]);

		await harness.session.prompt("hello");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: true });

		const result = await harness.session.applyCompaction(createPrecomputedCompaction(harness, "bound summary"), {
			reason: "extension",
			expectedRevision: harness.session.getMessageRevision(),
		});
		expect(result).toEqual({ applied: true, reason: "ok" });
		expect(harness.session.model?.id).toBe("faux-1");

		await harness.session.prompt("second");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "refusal" },
			{ from: primary, to: fallback, reason: "refusal" },
		]);
		expect(harness.eventsOfType("retry_fallback_reverted")).toMatchObject([{ from: fallback, to: primary }]);
		expect(fallbackState(harness)).toMatchObject({ pinned: true, pinnedByRefusal: true, pinnedByBilling: false });
	});

	it("(6) restores the primary before the queued continuation admitted after a mid-run compaction", async () => {
		// A tool result large enough to push the post-tool context over the
		// threshold of a 40k-token window, so compaction runs while the agent run
		// is still active (isStreaming) and its queued continuation follows.
		const largeToolResult = "tool output ".repeat(20_000);
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 40_000 },
				{ id: "faux-2", contextWindow: 40_000 },
			],
			fallbackNow: () => 0,
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "large_result",
						label: "Large Result",
						description: "Return text that pushes the session over the compaction threshold",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: largeToolResult }], details: {} }),
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "mid-run compaction summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const modelAtContinuation: string[] = [];
		const revertsBeforeContinuation: number[] = [];
		harness.setResponses([
			refusal("primary refusal"),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			() => {
				modelAtContinuation.push(harness.session.model?.id ?? "");
				revertsBeforeContinuation.push(harness.eventsOfType("retry_fallback_reverted").length);
				return fauxAssistantMessage("continuation answer");
			},
			fauxAssistantMessage("unexpected extra call"),
		]);

		await harness.session.prompt("run the large result tool");
		await harness.session.waitForIdle();

		// A senpi-owned compaction did succeed while the run was active.
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === true)).toHaveLength(1);

		// The next provider request after that compaction must run on the primary,
		// with exactly one revert emitted before it.
		expect(revertsBeforeContinuation).toEqual([1]);
		expect(modelAtContinuation).toEqual(["faux-1"]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-1"]);
		expect(harness.eventsOfType("retry_fallback_reverted")).toMatchObject([{ from: fallback, to: primary }]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(fallbackState(harness)).toBeUndefined();
	});
});
