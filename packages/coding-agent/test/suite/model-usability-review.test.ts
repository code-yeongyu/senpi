import { afterEach, describe, expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createHarness, type Harness } from "./harness.ts";

function seed(harness: Harness, tokens: number): void {
	const model = harness.getModel();
	const timestamp = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "context ".repeat(30_000) }],
		timestamp,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "response" }],
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
		timestamp: timestamp + 1,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("model usability review regressions", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("does not double-count the fixed prefix on a downswitch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "target", contextWindow: 372_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		seed(harness, 275_000);
		const target = harness.getModel("target");
		if (!target) throw new Error("missing downswitch target fixture");
		await harness.session.setModel(target);
		expect(harness.session.model?.id).toBe("target");
	});

	it("checks live context for an equal-window target with larger output", async () => {
		const harness = await createHarness({
			models: [
				{ id: "current", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "target", contextWindow: 100_000, maxTokens: 40_000 },
			],
		});
		harnesses.push(harness);
		seed(harness, 95_000);
		const target = harness.getModel("target");
		if (!target) throw new Error("missing equal-window target fixture");
		await expect(harness.session.setModel(target)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(harness.session.model?.id).toBe("current");
	});

	it("revalidates live context after a favorite-cycle model_select hook changes the prompt", async () => {
		const harness = await createHarness({
			models: [
				{ id: "current", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "target", contextWindow: 80_000, maxTokens: 4_000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) =>
						event.model.id === "target" ? { systemPrompt: "target prompt ".repeat(10_000) } : undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		seed(harness, 20_000);
		const current = harness.getModel("current");
		const target = harness.getModel("target");
		if (!current || !target) throw new Error("missing favorite-cycle model fixture");
		harness.session.setFavoriteModels([{ model: current }, { model: target }]);
		await expect(harness.session.cycleModel()).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(harness.session.model?.id).toBe("current");
	});

	it("rolls back model and prompt after an unusable model-specific prompt", async () => {
		const harness = await createHarness({
			models: [
				{ id: "current", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "target", contextWindow: 100_000, maxTokens: 4_000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) =>
						event.model.id === "target" ? { systemPrompt: "large ".repeat(100_000) } : undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		const initialPrompt = harness.session.systemPrompt;
		const target = harness.getModel("target");
		if (!target) throw new Error("missing prompt-rollback target fixture");
		await expect(harness.session.setModel(target)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(harness.session.model?.id).toBe("current");
		expect(harness.session.systemPrompt).toBe(initialPrompt);
	});
});
