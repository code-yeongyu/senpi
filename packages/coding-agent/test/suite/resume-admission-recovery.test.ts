import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function seedOverBudget(harness: Harness, tokens: number): void {
	const timestamp = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "! ".repeat(Math.max(100, tokens * 2)) }],
		timestamp: timestamp - 3,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "earlier answer" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 2_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: timestamp - 2,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continue" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "still working" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("resume admission recovery", () => {
	it("opens an over-budget restored session with a synthetic summary and a pending recovery compaction", async () => {
		const harness = await createHarness({ models: [{ id: "tiny", contextWindow: 64_000, maxTokens: 4_000 }] });
		seedOverBudget(harness, 60_000);
		// given a restored session whose messages exceed the window; open it
		const result = await createAgentSession({
			cwd: harness.tempDir,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			model: harness.getModel("tiny"),
		});
		// the admission must not throw; the session opens
		expect(result.session).toBeDefined();
		// the restored context carries a synthetic summary, not the raw oversized prefix
		const messages = result.session.agent.state.messages;
		const summary = messages.find((m) => m.role === "compactionSummary");
		expect(summary).toBeDefined();
		const admissionCompactions = harness.sessionManager
			.getEntries()
			.filter(
				(entry): entry is CompactionEntry<{ origin?: string }> =>
					entry.type === "compaction" &&
					(entry.details as { origin?: string } | undefined)?.origin === "resume-admission",
			);
		expect(admissionCompactions).toHaveLength(1);
		const admission = admissionCompactions[0];
		if (admission?.type !== "compaction") throw new Error("missing admission compaction");
		expect(harness.sessionManager.getEntry(admission.firstKeptEntryId)).toBeDefined();
		// the verbatim log is untouched: the full prefix is still present
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message).includes("! ! !"),
				),
		).toBe(true);
		// first turn must run recovery compaction before the prompt
		expect(result.session.hasPendingResumeRecovery()).toBe(true);
		harness.cleanup();
	});

	it("a budget-fitting restored session opens unchanged (no synthetic summary, no pending recovery)", async () => {
		const harness = await createHarness({ models: [{ id: "roomy", contextWindow: 128_000, maxTokens: 4_000 }] });
		seedOverBudget(harness, 20_000);
		const result = await createAgentSession({
			cwd: harness.tempDir,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			model: harness.getModel("roomy"),
		});
		const messages = result.session.agent.state.messages;
		expect(messages.find((m) => m.role === "compactionSummary")).toBeUndefined();
		expect(result.session.hasPendingResumeRecovery()).toBe(false);
		harness.cleanup();
	});
});
