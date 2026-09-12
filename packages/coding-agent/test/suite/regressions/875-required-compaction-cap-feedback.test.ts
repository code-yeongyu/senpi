import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { projectModelUsabilityBudget } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import type { CompactionRejectionCause } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

// PR #875: preserve a legacy extension's cap verdict at actual provider admission.
// Main's builtin no longer caps successful compactions; do not restore that policy.
describe("required compaction cap feedback", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each(["prompt", "custom", "resume"] as const)(
		"preserves request-specific cap feedback at %s admission without calling the provider",
		async (admission) => {
			// Given a real compactable transcript and a legacy extension cap rejection.
			let rejectionCause: CompactionRejectionCause = "per-turn-cap";
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
				settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async () => ({ cancel: true, rejectionCause }));
					},
				],
			});
			harnesses.push(harness);
			const model = harness.getModel();
			for (let turn = 0; turn < 2; turn++) {
				harness.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "saved prompt" }],
					timestamp: turn * 2,
				});
				harness.sessionManager.appendMessage({
					...fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "context_length_exceeded",
						timestamp: turn * 2 + 1,
					}),
					api: model.api,
					provider: model.provider,
					model: model.id,
				});
			}
			harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const manualError = await harness.session.compact().catch((error: unknown) => error);
			if (!(manualError instanceof Error)) throw new Error("Expected manual rejection");
			if (admission === "resume") {
				const projection = projectModelUsabilityBudget({
					model,
					systemPrompt: harness.agent.state.systemPrompt,
					tools: harness.agent.state.tools,
					liveContextTokens: 20_000,
					compaction: harness.settingsManager.getCompactionSettings(),
					includeSpeculationLead: false,
					admission: "resume",
				});
				expect(projection.usable).toBe(false);
				harness.session.admitResumeCompactionRequired(projection);
			}
			const trigger = () =>
				admission === "custom"
					? harness.session.sendCustomMessage(
							{ customType: "875-admission", content: "next turn", display: true },
							{ triggerTurn: true },
						)
					: harness.session.prompt("next turn");

			// When admission requires the rejected compaction.
			const result = trigger();

			// Then both error channels carry the same shipped recovery copy and cause.
			await expect(result).rejects.toMatchObject({
				name: "RequiredCompactionError",
				rejectionCause: "per-turn-cap",
			});
			const event = harness.eventsOfType("compaction_end").at(-1);
			expect(event).toMatchObject({ accepted: false, rejectionCause: "per-turn-cap" });
			await expect(result).rejects.toThrow(manualError.message);
			expect(harness.faux.state.callCount).toBe(0);

			// A later, different verdict must not reuse the previous request's cap cause.
			rejectionCause = "cancelled-by-extension";
			await expect(trigger()).rejects.toMatchObject({
				name: "RequiredCompactionError",
				rejectionCause: undefined,
			});
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				accepted: false,
				rejectionCause: "cancelled-by-extension",
			});
			expect(harness.faux.state.callCount).toBe(0);
		},
	);
});
