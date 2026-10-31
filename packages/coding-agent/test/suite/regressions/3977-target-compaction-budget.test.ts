import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	ModelUsabilityBudgetError,
	projectModelUsabilityBudget,
} from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("#3977 / #3636 target-owned compaction budget", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	for (const contextWindow of [128_000, 400_000]) {
		it.each(["default", "ordinary", "override"] as const)(
			`admits an empty session to ${contextWindow} with the target's %s reserve`,
			async (setting) => {
				const harness = await createHarness({
					provider: "faux",
					models: [
						{ id: "million", contextWindow: 1_000_000, maxTokens: 8_192 },
						{ id: "target", contextWindow, maxTokens: 8_192 },
					],
					tools: [],
					settings: {
						compaction: {
							...(setting === "ordinary" ? { reserveTokens: 24_000 } : {}),
							modelOverrides: {
								"faux/million": { reserveTokens: 750_000, keepRecentTokens: 120_000 },
								...(setting === "override"
									? { "faux/target": { reserveTokens: 28_000, keepRecentTokens: 1_024 } }
									: {}),
							},
						},
					},
				});
				harnesses.push(harness);
				const target = harness.getModel("target")!;
				expect(harness.session.model?.id).toBe("million");
				await harness.session.setModel(target);
				expect(harness.session.model?.id).toBe("target");
				expect(harness.session.pendingModelSwitch).toBeUndefined();
				expect(harness.eventsOfType("model_change_rejected")).toHaveLength(0);
			},
		);

		it(`rejects real ${contextWindow} overflow using only target overhead`, async () => {
			const harness = await createHarness({
				provider: "faux",
				models: [
					{ id: "million", contextWindow: 1_000_000, maxTokens: 8_192 },
					{ id: "target", contextWindow, maxTokens: 8_192 },
				],
				tools: [],
				settings: {
					compaction: {
						modelOverrides: {
							"faux/million": { reserveTokens: 672_000 },
							"faux/target": { reserveTokens: 20_000 },
						},
					},
				},
			});
			harnesses.push(harness);
			const target = harness.getModel("target")!;
			const expected = projectModelUsabilityBudget({
				model: target,
				systemPrompt: harness.agent.state.systemPrompt,
				tools: harness.agent.state.tools,
				compaction: harness.settingsManager.getCompactionSettings(target),
				liveContextTokens: contextWindow,
				admission: "switch",
				includeSpeculationLead: false,
			});
			let error: unknown;
			try {
				harness.session.assertModelUsable(target, contextWindow, {
					admission: "switch",
					includeSpeculationLead: false,
				});
			} catch (reason) {
				error = reason;
			}
			expect(error).toBeInstanceOf(ModelUsabilityBudgetError);
			if (!(error instanceof ModelUsabilityBudgetError)) throw new Error("expected overflow rejection");
			expect(error.projection).toEqual(expected);
			expect(error.projection.compactionReserveTokens).toBe(20_000);
			expect(error.projection.shortfallTokens).toBe(expected.requiredTokens - contextWindow);
			expect(harness.session.model?.id).toBe("million");
		});

		it(`admits a tiny live session to ${contextWindow} without source overrides`, async () => {
			const harness = await createHarness({
				provider: "faux",
				models: [
					{ id: "million", contextWindow: 1_000_000, maxTokens: 8_192 },
					{ id: "target", contextWindow, maxTokens: 8_192 },
				],
				tools: [],
				settings: { compaction: { modelOverrides: { "faux/million": { reserveTokens: 672_000 } } } },
			});
			harnesses.push(harness);
			harness.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			const assistant = fauxAssistantMessage("hello");
			harness.sessionManager.appendMessage({
				...assistant,
				provider: "faux",
				model: "million",
				usage: { ...assistant.usage, input: 100, totalTokens: 100 },
			});
			harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			await harness.session.setModel(harness.getModel("target")!);
			expect(harness.session.model?.id).toBe("target");
			expect(harness.session.pendingModelSwitch).toBeUndefined();
		});
	}
});
