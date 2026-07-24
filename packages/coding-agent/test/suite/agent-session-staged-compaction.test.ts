import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const CONTEXT_WINDOW = 2_000;
const RESERVE_TOKENS = 400;
const OVERSIZED_ONE_SHOT_SUMMARY = "oversized summary ".repeat(500);

function assistant(text: string): AssistantMessage {
	return {
		...fauxAssistantMessage(text),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function seedTurns(harness: Harness, turnCount: number, charsPerMessage = 400): void {
	const baseTimestamp = Date.now() - turnCount * 2_000;
	for (let index = 0; index < turnCount; index++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `user-${index}:${"u".repeat(charsPerMessage)}` }],
			timestamp: baseTimestamp + index * 2_000,
		});
		harness.sessionManager.appendMessage(
			Object.assign(assistant(`assistant-${index}:${"a".repeat(charsPerMessage)}`), {
				timestamp: baseTimestamp + index * 2_000 + 1_000,
			}),
		);
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function stagedSummaryExtension(options?: { failAtStage?: number; stageCalls?: number[] }) {
	return (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", async (event) => {
			if (!event.stage) {
				return {
					compaction: {
						summary: OVERSIZED_ONE_SHOT_SUMMARY,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}

			options?.stageCalls?.push(event.stage.index);
			if (event.stage.index === options?.failAtStage) {
				return { cancel: true, reason: `stage ${event.stage.index} failed` };
			}

			return {
				compaction: {
					summary: `accepted stage ${event.stage.index}`,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	};
}

async function runOverflowRecovery(harness: Harness): Promise<boolean> {
	const run = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof run !== "function") throw new Error("AgentSession._runAutoCompaction is unavailable");
	return await run.call(harness.session, "overflow", true);
}

async function createStagedHarness(extension: (pi: ExtensionAPI) => void): Promise<Harness> {
	return await createHarness({
		models: [{ id: "faux-staged", contextWindow: CONTEXT_WINDOW }],
		settings: {
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: RESERVE_TOKENS },
		},
		extensionFactories: [extension],
	});
}

describe("AgentSession staged compaction recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("durably advances through multiple stages and finishes below budget", async () => {
		const stageCalls: number[] = [];
		const harness = await createStagedHarness(stagedSummaryExtension({ stageCalls }));
		harnesses.push(harness);
		seedTurns(harness, 14);

		const result = await harness.session.compact();

		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const acceptedStages = harness
			.eventsOfType("compaction_end")
			.filter((event) => event.accepted && event.stage !== undefined);
		expect(stageCalls.length).toBeGreaterThanOrEqual(2);
		expect(entries).toHaveLength(stageCalls.length);
		expect(new Set(entries.map((entry) => entry.firstKeptEntryId)).size).toBe(entries.length);
		expect(acceptedStages.at(-1)?.stage?.final).toBe(true);
		expect(acceptedStages.slice(0, -1).every((event) => event.stage?.final === false)).toBe(true);
		expect(result.summary).toBe(`accepted stage ${stageCalls.at(-1)}`);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(CONTEXT_WINDOW - RESERVE_TOKENS);
	});

	it("recovers when the one-shot summarization request itself overflows", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-staged", contextWindow: CONTEXT_WINDOW }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: RESERVE_TOKENS },
			},
		});
		harnesses.push(harness);
		seedTurns(harness, 14);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Your input exceeds the context window of this model",
			}),
			...Array.from({ length: 8 }, (_value, index) => fauxAssistantMessage(`core stage ${index + 1}`)),
		]);

		const result = await harness.session.compact();

		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(3);
		expect(entries.length).toBe(harness.faux.state.callCount - 1);
		expect(result.summary).toMatch(/^core stage /);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(CONTEXT_WINDOW - RESERVE_TOKENS);
	});

	it("marks only the final accepted stage for the original prompt retry", async () => {
		const stageCalls: number[] = [];
		const harness = await createStagedHarness(stagedSummaryExtension({ stageCalls }));
		harnesses.push(harness);
		seedTurns(harness, 14);
		harness.sessionManager.appendMessage({
			...assistant(""),
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let continuationCount = 0;
		Reflect.set(harness.session, "_scheduleContinuationAfterCurrentEvent", () => {
			continuationCount++;
		});

		const recovered = await runOverflowRecovery(harness);

		const acceptedStages = harness
			.eventsOfType("compaction_end")
			.filter((event) => event.accepted && event.stage !== undefined);
		expect(recovered).toBe(true);
		expect(acceptedStages.length).toBeGreaterThanOrEqual(2);
		expect(acceptedStages.slice(0, -1).every((event) => event.willRetry === false)).toBe(true);
		expect(acceptedStages.at(-1)?.willRetry).toBe(true);
		expect(continuationCount).toBe(1);
	});

	it("fails explicitly when the oldest complete turn cannot fit one stage", async () => {
		const stageCalls: number[] = [];
		const harness = await createStagedHarness(stagedSummaryExtension({ stageCalls }));
		harnesses.push(harness);
		seedTurns(harness, 1, 4_000);
		seedTurns(harness, 1, 20);

		await expect(harness.session.compact()).rejects.toThrow(/cannot fit the oldest complete turn/i);
		expect(stageCalls).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("keeps an accepted checkpoint when a later stage fails", async () => {
		const stageCalls: number[] = [];
		const harness = await createStagedHarness(stagedSummaryExtension({ failAtStage: 2, stageCalls }));
		harnesses.push(harness);
		seedTurns(harness, 14);

		await expect(harness.session.compact()).rejects.toThrow();

		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(stageCalls).toEqual([1, 2]);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.summary).toBe("accepted stage 1");
		expect(harness.sessionManager.buildSessionContext().messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: "accepted stage 1",
		});
	});

	it("stops at the hard stage bound without retrying the original prompt", async () => {
		const stageCalls: number[] = [];
		const harness = await createStagedHarness(stagedSummaryExtension({ stageCalls }));
		harnesses.push(harness);
		seedTurns(harness, 50);

		await expect(harness.session.compact()).rejects.toThrow();

		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(stageCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(entries).toHaveLength(7);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.stage)).toHaveLength(8);
	});
});
