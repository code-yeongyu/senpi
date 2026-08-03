import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
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
			accepted: false,
			rejectionCause: "cancelled-by-extension",
		});
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
			compactionQueuedMessages: [] as Array<{ text: string; mode: string; enqueueOrder: number }>,
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
