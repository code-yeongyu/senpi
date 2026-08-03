import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const REQUIRED_COMPACTION_ERROR = "Context remains above the compaction threshold because compaction did not complete";

function textResultTool(repetitions: number): AgentTool {
	return {
		name: "large_result",
		label: "Large Result",
		description: "Return enough persisted output to require compaction",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "large persisted tool result ".repeat(repetitions) }],
			details: {},
		}),
	};
}

describe("required-compaction recovery bounds", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("resumes the interrupted tool continuation without a valid usage anchor", async () => {
		let compactionRequest = 0;
		const harness = await createHarness({
			models: [{ id: "required-recovery-continuation", contextWindow: 5_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
			tools: [textResultTool(2_000)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactionRequest++;
						if (compactionRequest === 1) {
							return {
								cancel: true,
								rejectionCause: "cancelled-by-extension",
								reason: "reject inline compaction once",
							} as const;
						}
						return {
							compaction: {
								summary: "effective required recovery summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		const zeroUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "toolUse"
			) {
				event.message.usage = zeroUsage;
			}
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("interrupted continuation resumed"),
		]);

		await harness.session.prompt("start required recovery");
		await harness.session.waitForSettledSessionWork();

		expect(
			harness
				.eventsOfType("agent_end")
				.some(
					(event) =>
						event.willRetry === true &&
						event.messages.some(
							(message) => message.role === "assistant" && message.errorMessage === REQUIRED_COMPACTION_ERROR,
						),
				),
		).toBe(true);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "threshold",
				accepted: true,
				willRetry: true,
			}),
		);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(harness)).toContain("interrupted continuation resumed");
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("continues once after recovery clears the threshold", async () => {
		let compactionRequest = 0;
		const queuedMarker = "queued while effective recovery finishes";
		const harness = await createHarness({
			models: [{ id: "effective-required-recovery", contextWindow: 5_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
			tools: [textResultTool(2_000)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactionRequest++;
						if (compactionRequest === 1) {
							return {
								cancel: true,
								rejectionCause: "cancelled-by-extension",
								reason: "reject inline compaction once",
							} as const;
						}
						pi.sendUserMessage(queuedMarker, { deliverAs: "steer" });
						return {
							compaction: {
								summary: "effective recovery summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("interrupted continuation resumed"),
			fauxAssistantMessage("queued input handled after effective recovery"),
		]);

		await harness.session.prompt("start effective required recovery");
		await harness.session.waitForSettledSessionWork();

		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "threshold",
				accepted: true,
				willRetry: true,
			}),
		);
		expect(harness.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(harness)).toContain("interrupted continuation resumed");
		expect(getAssistantTexts(harness)).toContain("queued input handled after effective recovery");
		expect(getAssistantTexts(harness)).not.toContain("No more faux responses queued");
		expect(getUserTexts(harness).filter((text) => text === queuedMarker)).toHaveLength(1);
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.errorMessage === REQUIRED_COMPACTION_ERROR,
				),
		).toHaveLength(1);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("resolves the originating prompt after accepted recovery completes a queued steer", async () => {
		let compactionRequest = 0;
		const queuedMarker = "steer queued before failed inline admission";
		const harness = await createHarness({
			models: [{ id: "queued-recovery-admission", contextWindow: 5_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
			tools: [textResultTool(2_000)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactionRequest++;
						if (compactionRequest === 1) {
							return {
								cancel: true,
								rejectionCause: "cancelled-by-extension",
								reason: "reject inline compaction once",
							} as const;
						}
						return {
							compaction: {
								summary: "accepted required recovery summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		let releaseFirstTurn: (() => void) | undefined;
		const firstTurnReady = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve;
		});
		harness.setResponses([
			async () => {
				releaseFirstTurn?.();
				return fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("queued steer completed after recovery"),
		]);

		const origin = harness.session.prompt("start queued admission recovery");
		await firstTurnReady;
		const queued = harness.session.prompt(queuedMarker, { streamingBehavior: "steer" });

		// The originating prompt must resolve once the accepted recovery has
		// admitted the queued steer; the superseded admission error must not leak.
		await origin;
		await queued;
		await harness.session.waitForSettledSessionWork();

		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "threshold", accepted: true, willRetry: true }),
		);
		expect(getAssistantTexts(harness)).toContain("queued steer completed after recovery");
		expect(getUserTexts(harness).filter((text) => text === queuedMarker)).toHaveLength(1);
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});
});
