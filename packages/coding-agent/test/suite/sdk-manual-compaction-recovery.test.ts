import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

/**
 * `claude-sdk-oauth` is the regression case: it fails without the manual ownership
 * exemption, with `rejectionCause: "external-owner"`. `faux` is a deliberate control
 * for the lane the exemption must NOT change - it reaches the same persisted-summary
 * outcome through the ordinary senpi-owned path, and it fails if the shared
 * `ownsCompaction` predicate ever regresses the non-SDK branch.
 */
describe("explicit compaction recovers a rejected model downswitch", () => {
	it.each(["claude-sdk-oauth", "faux"])("persists a usable manual summary on %s", async (provider) => {
		// Given the real builtin, no compaction-model override, and an oversized live transcript.
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const harness = await createHarness({
			provider,
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "target", contextWindow: 272_000, maxTokens: 32_000 },
			],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [compactionExtension],
			persistSession: true,
		});
		harnesses.push(harness);
		const source = harness.getModel();
		const target = harness.getModel("target");
		if (!target) throw new Error("missing target fixture");
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "historical context ".repeat(30_000) }],
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("historical response", { timestamp: 2 }),
			api: source.api,
			provider,
			model: source.id,
			usage: {
				input: 845_096,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 845_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const keptEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "KEEP_AFTER_COMPACTION" }],
			timestamp: 3,
		});
		harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await expect(harness.session.setModel(target)).rejects.toMatchObject({
			name: ModelUsabilityBudgetError.name,
			projection: { usable: false, contextWindow: 272_000 },
		});
		expect(harness.session.model?.id).toBe("million");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
		const summary = "MANUAL_COMPACTION_RECOVERY_SUMMARY";
		harness.setResponses([fauxAssistantMessage(summary, { timestamp: 4 })]);

		// When explicit /compact's session entry point runs, the harness is already subscribed
		// to lifecycle events. Await its terminal promise, not elapsed time or polling.
		const outcome = await harness.session.compact().then(
			(result) => ({ status: "compacted" as const, result }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);

		// Then cancellation is not recovery: require an actual result and persisted usable history.
		expect(outcome, JSON.stringify(harness.eventsOfType("compaction_end"))).toMatchObject({ status: "compacted" });
		if (outcome.status !== "compacted") throw outcome.error;
		expect(outcome.result).toMatchObject({ summary, firstKeptEntryId: keptEntryId });
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "manual", accepted: true, aborted: false }),
		]);
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("missing persisted session fixture");
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getEntries().filter((entry) => entry.type === "compaction")).toEqual([
			expect.objectContaining({ summary, firstKeptEntryId: keptEntryId }),
		]);
		expect(reopened.buildSessionContext().messages).toEqual(harness.session.messages);
		expect(harness.session.messages).toEqual([
			expect.objectContaining({ role: "compactionSummary", summary }),
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "KEEP_AFTER_COMPACTION" }] }),
		]);
		await harness.session.setModel(target);
		expect(harness.session.model?.id).toBe("target");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([
			expect.objectContaining({ provider, modelId: "target" }),
		]);
	});
});
