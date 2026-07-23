import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

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

describe("AgentSession applyCompaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("returns stale when expected revision no longer matches", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		const expectedRevision = harness.session.getMessageRevision();

		await harness.session.prompt("one");
		const precomputed = createPrecomputedCompaction(harness, "stale summary");

		// when
		const result = await harness.session.applyCompaction(precomputed, {
			reason: "extension",
			expectedRevision,
		});

		// then
		expect(result).toEqual({ applied: false, reason: "stale" });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("applies precomputed compaction when expected revision matches", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);

		await harness.session.prompt("one");
		const expectedRevision = harness.session.getMessageRevision();
		const precomputed = createPrecomputedCompaction(harness, "fresh summary");

		// when
		const result = await harness.session.applyCompaction(precomputed, {
			reason: "extension",
			expectedRevision,
		});

		// then
		expect(result).toEqual({ applied: true, reason: "ok" });
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("rejects precomputed compaction created before a model switch", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "small", contextWindow: 32_000 },
				{ id: "large", contextWindow: 800_000 },
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		await harness.session.prompt("one");
		const expectedRevision = harness.session.getMessageRevision();
		const precomputed = createPrecomputedCompaction(harness, "stale after model switch");
		const largeModel = harness.getModel("large");
		if (!largeModel) {
			throw new Error("Expected large model");
		}

		// when
		await harness.session.setModel(largeModel);
		const result = await harness.session.applyCompaction(precomputed, {
			reason: "extension",
			expectedRevision,
		});

		// then
		expect(result).toEqual({ applied: false, reason: "stale" });
		expect(harness.session.getMessageRevision()).toBeGreaterThan(expectedRevision);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("increments message revision monotonically for message and compaction mutations", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		const initialRevision = harness.session.getMessageRevision();

		// when
		await harness.session.prompt("one");
		const afterPromptRevision = harness.session.getMessageRevision();
		const precomputed = createPrecomputedCompaction(harness, "monotonic summary");
		await harness.session.applyCompaction(precomputed, {
			reason: "extension",
			expectedRevision: afterPromptRevision,
		});
		const afterCompactionRevision = harness.session.getMessageRevision();

		// then
		expect(afterPromptRevision).toBeGreaterThan(initialRevision);
		expect(afterCompactionRevision).toBeGreaterThan(afterPromptRevision);
	});

	it("emits one compaction start while an extension prepares and applies a summary", async () => {
		// given
		const observedCompactionStates: string[] = [];
		let harness: Harness;
		const extension = (pi: ExtensionAPI): void => {
			pi.on("before_agent_start", async (_event, ctx) => {
				const entries = ctx.sessionManager.getEntries();
				const firstEntry = entries[0];
				if (!firstEntry || entries.some((entry) => entry.type === "compaction")) {
					return undefined;
				}

				ctx.beginCompaction?.({ reason: "extension" });
				observedCompactionStates.push(harness.session.compactionState.status);
				await ctx.applyCompaction(
					{
						summary: "extension feedback summary",
						firstKeptEntryId: firstEntry.id,
						tokensBefore: 42,
					},
					{ reason: "extension", expectedRevision: ctx.getMessageRevision() },
				);
				return undefined;
			});
		};
		harness = await createHarness({ extensionFactories: [extension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		harness.events.length = 0;

		// when
		await harness.session.prompt("two");

		// then
		const compactionEvents = harness.events.filter(
			(event) => event.type === "compaction_start" || event.type === "compaction_end",
		);
		expect(compactionEvents).toHaveLength(2);
		expect(compactionEvents[0]).toEqual({ type: "compaction_start", reason: "extension" });
		expect(compactionEvents[1]).toMatchObject({
			type: "compaction_end",
			reason: "extension",
			aborted: false,
		});
		expect(observedCompactionStates).toEqual(["running"]);
	});
});
