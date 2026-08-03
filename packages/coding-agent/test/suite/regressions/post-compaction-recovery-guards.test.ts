import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const REQUIRED_COMPACTION_ERROR = "Context remains above the compaction threshold because compaction did not complete";

function largeResultTool(): AgentTool {
	return {
		name: "large_result",
		label: "Large Result",
		description: "Return enough persisted output to require compaction",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "large persisted tool result ".repeat(2_000) }],
			details: {},
		}),
	};
}

describe("post-compaction recovery guards", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("does not retry a provider error that copies the required-compaction text", async () => {
		const harness = await createHarness({
			models: [{ id: "provider-lookalike-compaction-error", contextWindow: 5_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		const providerError = fauxAssistantMessage("provider supplied error", {
			stopReason: "error",
			errorMessage: REQUIRED_COMPACTION_ERROR,
		});
		const classifyRequiredCompactionError: unknown = Reflect.get(harness.session, "_isRequiredCompactionError");
		expect(typeof classifyRequiredCompactionError).toBe("function");
		if (typeof classifyRequiredCompactionError !== "function") {
			throw new Error("Required-compaction provenance classifier is unavailable");
		}
		expect(Reflect.apply(classifyRequiredCompactionError, harness.session, [providerError])).toBe(false);
		harness.setResponses([providerError, fauxAssistantMessage("must not continue")]);

		await harness.session.prompt("return a provider error");
		await harness.session.waitForSettledSessionWork();

		const matchingAgentEnds = harness
			.eventsOfType("agent_end")
			.filter((event) =>
				event.messages.some(
					(message) => message.role === "assistant" && message.errorMessage === REQUIRED_COMPACTION_ERROR,
				),
			);
		expect(matchingAgentEnds).toHaveLength(1);
		expect(matchingAgentEnds[0]?.willRetry).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("must not continue");
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not inherit stale provenance into a later run with the same provider error text", async () => {
		let compactionRequest = 0;
		const harness = await createHarness({
			models: [{ id: "stale-provenance-recovery", contextWindow: 5_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
			tools: [largeResultTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactionRequest++;
						if (compactionRequest === 1) {
							return {
								cancel: true,
								rejectionCause: "cancelled-by-extension",
								reason: "reject the first recovery only",
							} as const;
						}
						return {
							compaction: {
								summary: "later recovery accepted",
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
		harness.setResponses([fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" })]);

		// Run 1: a real required-compaction admission sets provenance, then fails.
		await harness.session.prompt("start provenance-setting run").then(
			() => undefined,
			() => undefined,
		);
		await harness.session.waitForSettledSessionWork();
		const callsAfterRun1 = harness.faux.state.callCount;

		// Run 2: provider returns an error with the SAME text. Stale provenance
		// would misclassify it as required-compaction and trigger another
		// compaction/admission cycle; the agent_start clear must prevent that.
		harness.setResponses([
			fauxAssistantMessage("provider lookalike error", {
				stopReason: "error",
				errorMessage: REQUIRED_COMPACTION_ERROR,
			}),
			fauxAssistantMessage("must not continue"),
		]);
		await harness.session.prompt("provider lookalike run").then(
			() => undefined,
			() => undefined,
		);
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(callsAfterRun1 + 1);
		expect(getAssistantTexts(harness)).not.toContain("must not continue");
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		const run2CompactionEnds = harness.eventsOfType("compaction_end").filter((event) => event.reason === "threshold");
		expect(run2CompactionEnds.length).toBeLessThanOrEqual(2);
	});

	it("retains queued input when required recovery compaction is rejected", async () => {
		let compactionRequest = 0;
		let queuedAtErrorEnd = false;
		const rejectedSteer = "steer retained after rejected recovery";
		const rejectedFollowUp = "follow-up retained after rejected recovery";
		const harness = await createHarness({
			models: [{ id: "rejected-required-recovery", contextWindow: 5_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
			tools: [largeResultTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						compactionRequest++;
						return {
							cancel: true,
							rejectionCause: "cancelled-by-extension",
							reason:
								compactionRequest === 1 ? "reject inline compaction" : "reject required recovery compaction",
						} as const;
					});
				},
				(pi) => {
					pi.on("agent_end", (event) => {
						if (
							queuedAtErrorEnd ||
							!event.messages.some(
								(message) => message.role === "assistant" && message.errorMessage === REQUIRED_COMPACTION_ERROR,
							)
						) {
							return;
						}
						queuedAtErrorEnd = true;
						pi.sendUserMessage(rejectedSteer, { deliverAs: "steer" });
						pi.sendUserMessage(rejectedFollowUp, { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not continue after rejected recovery"),
		]);

		const admissionError = await harness.session.prompt("start rejected required recovery").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(admissionError instanceof Error ? admissionError.message : String(admissionError)).toBe(
			REQUIRED_COMPACTION_ERROR,
		);
		await harness.session.waitForSettledSessionWork();

		const compactionEnds = harness.eventsOfType("compaction_end");
		const requiredErrorAgentEndIndex = harness.events.findIndex(
			(event) =>
				event.type === "agent_end" &&
				event.willRetry === true &&
				event.messages.some(
					(message) => message.role === "assistant" && message.errorMessage === REQUIRED_COMPACTION_ERROR,
				),
		);
		const rejectedRecoveryIndex = harness.events.findIndex(
			(event, index) =>
				index > requiredErrorAgentEndIndex &&
				event.type === "compaction_end" &&
				event.reason === "threshold" &&
				event.accepted === false,
		);
		expect(compactionEnds).toHaveLength(2);
		expect(requiredErrorAgentEndIndex).toBeGreaterThanOrEqual(0);
		expect(rejectedRecoveryIndex).toBeGreaterThan(requiredErrorAgentEndIndex);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("must not continue after rejected recovery");
		expect(harness.session.getSteeringMessages()).toEqual([rejectedSteer]);
		expect(harness.session.getFollowUpMessages()).toEqual([rejectedFollowUp]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(getUserTexts(harness).some((text) => text.trim().toLowerCase() === "continue")).toBe(false);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});
});
