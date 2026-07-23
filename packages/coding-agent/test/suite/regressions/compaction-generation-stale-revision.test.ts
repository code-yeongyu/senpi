import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function compactionEntryCount(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

function agentMessagesContaining(harness: Harness, text: string): number {
	return harness.session.messages.filter((message) => getMessageText(message).includes(text)).length;
}

async function appendMidCompactionMessage(harness: Harness): Promise<void> {
	await harness.session.sendCustomMessage({
		customType: "mid-compaction-note",
		content: "arrived mid-compaction",
		display: true,
	});
}

describe("Regression: stale compaction generation after a revision change", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("rejects stale compaction when the session changes during extension preparation", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", async (event) => {
						preparationStarted.resolve();
						await releasePreparation.promise;
						return {
							compaction: {
								summary: "summary generated from a stale branch",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial assistant")]);
		await harness.session.prompt("initial prompt ".repeat(40));

		const compactPromise = harness.session.compact();
		await preparationStarted.promise;
		await appendMidCompactionMessage(harness);
		releasePreparation.resolve();

		await expect(compactPromise).rejects.toThrow();
		expect(compactionEntryCount(harness)).toBe(0);
		expect(agentMessagesContaining(harness, "arrived mid-compaction")).toBe(1);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === true)).toHaveLength(0);
	});

	it("rejects stale compaction when the session changes during summary generation", async () => {
		const generationStarted = createDeferred();
		const releaseGeneration = createDeferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial assistant"),
			async () => {
				generationStarted.resolve();
				await releaseGeneration.promise;
				return fauxAssistantMessage("provider generated summary");
			},
		]);
		await harness.session.prompt("initial prompt ".repeat(40));

		const compactPromise = harness.session.compact();
		await generationStarted.promise;
		await appendMidCompactionMessage(harness);
		releaseGeneration.resolve();

		await expect(compactPromise).rejects.toThrow();
		expect(compactionEntryCount(harness)).toBe(0);
		expect(agentMessagesContaining(harness, "arrived mid-compaction")).toBe(1);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === true)).toHaveLength(0);
	});

	it("keeps a delayed assistant message_end post-compaction despite its earlier payload timestamp", async () => {
		const assistantEndStarted = createDeferred();
		const releaseAssistantEnd = createDeferred();
		const payloadTimestamp = Date.now() - 10_000;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("message_end", async (event) => {
						if (
							event.message.role !== "assistant" ||
							!getMessageText(event.message).includes("delayed assistant payload")
						)
							return;
						assistantEndStarted.resolve();
						await releaseAssistantEnd.promise;
					});
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "subsequent admission must remain blocked",
					}));
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed pending persistence boundary" }],
			timestamp: payloadTimestamp - 1,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			{
				...fauxAssistantMessage("delayed assistant payload"),
				timestamp: payloadTimestamp,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1_200,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			fauxAssistantMessage("must not reach the next provider admission"),
		]);
		const delayedPrompt = harness.session.prompt("produce a delayed assistant");
		void delayedPrompt.catch(() => undefined);
		await assistantEndStarted.promise;
		const firstEntry = harness.sessionManager.getEntries()[0];
		if (!firstEntry) throw new Error("Expected a persisted entry before compaction");

		const applied = await harness.session.applyCompaction(
			{
				summary: "summary that fits the original context window",
				firstKeptEntryId: firstEntry.id,
				tokensBefore: 42,
			},
			{ reason: "extension" },
		);
		expect(applied).toEqual({ applied: true, reason: "ok" });
		expect(agentMessagesContaining(harness, "delayed assistant payload")).toBe(1);

		releaseAssistantEnd.resolve();
		await delayedPrompt;
		const branch = harness.sessionManager.getBranch();
		const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
		const delayedAssistantIndex = branch.findIndex(
			(entry) => entry.type === "message" && getMessageText(entry.message).includes("delayed assistant payload"),
		);
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		expect(delayedAssistantIndex).toBeGreaterThan(compactionIndex);
		const delayedAssistant = branch[delayedAssistantIndex];
		if (delayedAssistant?.type !== "message" || delayedAssistant.message.role !== "assistant") {
			throw new Error("Expected the delayed assistant entry after compaction");
		}
		expect(delayedAssistant.message.timestamp).toBe(payloadTimestamp);
		expect(new Date(branch[compactionIndex]!.timestamp).getTime()).toBeGreaterThan(payloadTimestamp);

		await expect(harness.session.prompt("subsequent admission")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
	});
});
