import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens } from "../src/core/compaction/index.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { filterContextExcludedMessages } from "../src/core/messages.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function readSessionLog(harness: Harness): Array<Record<string, unknown>> {
	const path = join(harness.tempDir, "agent", "logs", "session.log");
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8").trim();
	} catch {
		return [];
	}
	return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function getRunAutoCompaction(harness: Harness) {
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
	return (reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> =>
		Promise.resolve(runAutoCompaction.call(harness.session, reason, willRetry));
}

function emitSessionEvent(harness: Harness, event: Record<string, unknown>): void {
	const emit = Reflect.get(harness.session, "_emit");
	if (typeof emit !== "function") throw new Error("Expected AgentSession._emit");
	emit.call(harness.session, event);
}

describe("session.log stuck-route instrumentation", () => {
	it("logs compaction_decision with the rejection cause when compaction is rejected", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "test rejection",
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed handled")]);
		await harness.session.prompt("seed context ".repeat(40));

		await getRunAutoCompaction(harness)("threshold", false);
		await harness.session.waitForSettledSessionWork();

		const decisions = readSessionLog(harness).filter((line) => line.event === "compaction_decision");
		expect(decisions.length).toBeGreaterThan(0);
		expect(decisions.at(-1)).toMatchObject({
			reason: "threshold",
			mode: "auto",
			action: "compact",
			disposition: "rejected",
			accepted: false,
			skipped: false,
			tokensBefore: expect.any(Number),
			tokensAfter: expect.any(Number),
			rejectionCause: "cancelled-by-extension",
		});
	});

	it("logs token reduction and disposition when automatic compaction commits", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							estimatedTokensAfter: 321,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed handled")]);
		await harness.session.prompt("seed context ".repeat(40));

		await getRunAutoCompaction(harness)("threshold", false);
		await harness.session.waitForSettledSessionWork();

		const decisions = readSessionLog(harness).filter((line) => line.event === "compaction_decision");
		const decision = decisions.at(-1);
		expect(decision).toMatchObject({
			reason: "threshold",
			mode: "auto",
			action: "compact",
			disposition: "committed",
			accepted: true,
			skipped: false,
			tokensBefore: expect.any(Number),
			tokensAfter: expect.any(Number),
		});
		expect(decision?.tokensAfter).toBeLessThan(decision?.tokensBefore as number);
	});

	it("logs retry exhaustion as a skipped action without inventing a compaction attempt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Context overflow recovery was already attempted",
		});

		const decision = readSessionLog(harness).find((line) => line.event === "compaction_decision");
		expect(decision).toMatchObject({
			reason: "overflow",
			action: "none",
			disposition: "skipped",
			accepted: false,
			skipped: true,
			error: "Context overflow recovery was already attempted",
		});
		expect(decision).not.toHaveProperty("attemptId");
	});

	it("logs an accepted end as committed without a tracked compaction attempt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			accepted: true,
			aborted: false,
			willRetry: false,
		});

		const decision = readSessionLog(harness).find((line) => line.event === "compaction_decision");
		expect(decision).toMatchObject({
			reason: "threshold",
			action: "compact",
			disposition: "committed",
			accepted: true,
			skipped: false,
		});
		expect(decision).not.toHaveProperty("attemptId");
	});

	it("uses persisted context snapshots when an overflow attempt rolls back", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persisted overflow payload ".repeat(40) }],
			timestamp: Date.now(),
		});
		const expectedTokens = estimateContextTokens(
			filterContextExcludedMessages(harness.sessionManager.buildSessionContext().messages),
		).tokens;
		const attemptId = "33333333-3333-4333-8333-333333333333";

		emitSessionEvent(harness, { type: "compaction_start", reason: "overflow", requestId: attemptId });
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "overflow",
			requestId: attemptId,
			result: undefined,
			aborted: true,
			willRetry: false,
			rejectionCause: "cancelled-by-extension",
		});

		const decision = readSessionLog(harness).find((line) => line.event === "compaction_decision");
		expect(decision).toMatchObject({
			reason: "overflow",
			disposition: "rejected",
			tokensBefore: expectedTokens,
			tokensAfter: expectedTokens,
		});
	});

	it("logs extension feedback default failures as failed, not skipped", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const beginFeedback = Reflect.get(harness.session, "_beginExtensionCompactionFeedback");
		const endFeedback = Reflect.get(harness.session, "_endExtensionCompactionFeedback");
		if (typeof beginFeedback !== "function" || typeof endFeedback !== "function") {
			throw new Error("Expected extension compaction feedback methods");
		}

		const signal = beginFeedback.call(harness.session, "threshold") as AbortSignal;
		endFeedback.call(harness.session, { reason: "threshold", signal });

		const decision = readSessionLog(harness).find((line) => line.event === "compaction_decision");
		expect(decision).toMatchObject({
			reason: "threshold",
			action: "compact",
			disposition: "failed",
			accepted: false,
			skipped: false,
			error: "Compaction did not apply",
			attemptId: expect.any(String),
		});
	});

	it("correlates superseded starts with distinct attempt identifiers", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const thresholdAttemptId = "44444444-4444-4444-8444-444444444444";
		const overflowAttemptId = "55555555-5555-4555-8555-555555555555";

		emitSessionEvent(harness, {
			type: "compaction_start",
			reason: "threshold",
			requestId: thresholdAttemptId,
		});
		emitSessionEvent(harness, {
			type: "compaction_start",
			reason: "overflow",
			requestId: overflowAttemptId,
		});
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "overflow",
			requestId: overflowAttemptId,
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "overflow compaction failed",
		});

		const logs = readSessionLog(harness);
		const starts = logs.filter((line) => line.event === "compaction_start");
		const decisions = logs.filter((line) => line.event === "compaction_decision");
		expect(starts).toHaveLength(2);
		expect(starts[0]?.attemptId).not.toBe(starts[1]?.attemptId);
		expect(decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "threshold",
					disposition: "superseded",
					skipped: true,
					attemptId: starts[0]?.attemptId,
				}),
				expect.objectContaining({
					reason: "overflow",
					disposition: "failed",
					skipped: false,
					attemptId: starts[1]?.attemptId,
				}),
			]),
		);
	});

	it("does not attribute a stale same-reason end to the newer attempt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstAttemptId = "11111111-1111-4111-8111-111111111111";
		const secondAttemptId = "22222222-2222-4222-8222-222222222222";

		emitSessionEvent(harness, { type: "compaction_start", reason: "threshold", requestId: firstAttemptId });
		emitSessionEvent(harness, { type: "compaction_start", reason: "threshold", requestId: secondAttemptId });
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "threshold",
			requestId: firstAttemptId,
			result: undefined,
			accepted: true,
			aborted: false,
			willRetry: false,
		});
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "threshold",
			requestId: secondAttemptId,
			result: undefined,
			accepted: true,
			aborted: false,
			willRetry: false,
		});

		const logs = readSessionLog(harness);
		const starts = logs.filter((line) => line.event === "compaction_start");
		const decisions = logs.filter((line) => line.event === "compaction_decision");
		expect(starts.map((line) => line.attemptId)).toEqual([firstAttemptId, secondAttemptId]);
		expect(decisions.filter((line) => line.attemptId === firstAttemptId)).toEqual([
			expect.objectContaining({ disposition: "superseded", accepted: false }),
		]);
		expect(decisions.filter((line) => line.attemptId === secondAttemptId)).toEqual([
			expect.objectContaining({ disposition: "committed", accepted: true }),
		]);
	});

	it("suppresses an early stale terminal after more than 64 supersessions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const attemptIds = Array.from(
			{ length: 66 },
			(_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
		);

		for (const requestId of attemptIds) {
			emitSessionEvent(harness, { type: "compaction_start", reason: "threshold", requestId });
		}
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "threshold",
			requestId: attemptIds[0],
			result: undefined,
			accepted: true,
			aborted: false,
			willRetry: false,
		});
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "threshold",
			requestId: attemptIds.at(-1),
			result: undefined,
			accepted: true,
			aborted: false,
			willRetry: false,
		});

		const decisions = readSessionLog(harness).filter((line) => line.event === "compaction_decision");
		expect(decisions.filter((line) => line.attemptId === attemptIds[0])).toEqual([
			expect.objectContaining({ disposition: "superseded", accepted: false }),
		]);
		expect(decisions.filter((line) => line.attemptId === attemptIds.at(-1))).toEqual([
			expect.objectContaining({ disposition: "committed", accepted: true }),
		]);
	});

	it("does not attach no-ID retry exhaustion to an active same-reason attempt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const activeAttemptId = "66666666-6666-4666-8666-666666666666";

		emitSessionEvent(harness, {
			type: "compaction_start",
			reason: "overflow",
			requestId: activeAttemptId,
		});
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Context overflow recovery was already attempted",
		});
		emitSessionEvent(harness, {
			type: "compaction_end",
			reason: "overflow",
			requestId: activeAttemptId,
			result: undefined,
			accepted: true,
			aborted: false,
			willRetry: false,
		});

		const decisions = readSessionLog(harness).filter((line) => line.event === "compaction_decision");
		expect(decisions.find((line) => line.attemptId === undefined)).toMatchObject({
			reason: "overflow",
			action: "none",
			disposition: "skipped",
			accepted: false,
			skipped: true,
			error: "Context overflow recovery was already attempted",
		});
		expect(decisions.filter((line) => line.attemptId === activeAttemptId)).toEqual([
			expect.objectContaining({ disposition: "committed", accepted: true }),
		]);
	});

	it("keeps consecutive threshold compactions independently observable", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							estimatedTokensAfter: 321,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("first context ".repeat(40));
		await getRunAutoCompaction(harness)("threshold", false);
		await harness.session.prompt("second context ".repeat(40));
		await getRunAutoCompaction(harness)("threshold", false);
		await harness.session.waitForSettledSessionWork();

		const decisions = readSessionLog(harness).filter(
			(line) => line.event === "compaction_decision" && line.disposition === "committed",
		);
		expect(decisions).toHaveLength(2);
		for (const decision of decisions) {
			expect(decision).toMatchObject({
				reason: "threshold",
				mode: "auto",
				action: "compact",
				tokensBefore: expect.any(Number),
				tokensAfter: expect.any(Number),
			});
			expect(decision.tokensAfter).toBeLessThan(decision.tokensBefore as number);
		}
		expect(Reflect.get(harness.session, "_autoCompactionAbortController")).toBeUndefined();
		expect(Reflect.get(harness.session, "_pendingCompactionAdmission")).toBeUndefined();
		expect(Reflect.get(harness.session, "_postCompactionDeferredSteeringMessages")).toEqual([]);
		expect(Reflect.get(harness.session, "_postCompactionDeferredFollowUpMessages")).toEqual([]);
	});

	it("logs compaction_start before the decision so a wedged compaction is visible (issue #650)", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "test rejection",
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed handled")]);
		await harness.session.prompt("seed context ".repeat(40));

		await getRunAutoCompaction(harness)("threshold", false);
		await harness.session.waitForSettledSessionWork();

		const events = readSessionLog(harness).filter(
			(line) => line.event === "compaction_start" || line.event === "compaction_decision",
		);
		expect(events[0]).toMatchObject({ event: "compaction_start", reason: "threshold" });
		expect(events.at(-1)?.event).toBe("compaction_decision");
	});

	it("logs queue_enqueue for native steer and followUp queueing", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed handled")]);
		await harness.session.prompt("seed");

		await harness.session.steer("queued steer text");
		await harness.session.followUp("queued follow-up text");

		const enqueues = readSessionLog(harness).filter((line) => line.event === "queue_enqueue");
		expect(enqueues.map((line) => line.mode)).toEqual(["steer", "followUp"]);
		expect(enqueues.every((line) => typeof line.count === "number" && line.count >= 1)).toBe(true);
		expect(JSON.stringify(enqueues)).not.toContain("queued steer text");
	});

	it("logs compaction_queue_enqueue when the TUI parks input during compaction", () => {
		const queueCompactionMessage = Reflect.get(InteractiveMode.prototype, "queueCompactionMessage");
		if (typeof queueCompactionMessage !== "function") throw new Error("Expected queueCompactionMessage");
		const sessionLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
		const context = {
			optimisticUserEchoes: {
				begin: vi.fn(() => "pending-test"),
			},
			compactionQueuedMessages: [] as Array<{
				text: string;
				mode: string;
				enqueueOrder: number;
				pendingEchoId?: string;
			}>,
			session: { reserveQueuedInputOrder: () => 1 },
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
			getSessionLogger: () => sessionLogger,
		};

		queueCompactionMessage.call(context, "held message", "steer");

		expect(context.compactionQueuedMessages).toHaveLength(1);
		expect(sessionLogger.debug).toHaveBeenCalledWith(
			"compaction_queue_enqueue",
			expect.objectContaining({ mode: "steer", count: 1 }),
		);
	});
});
