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
});
