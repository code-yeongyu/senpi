import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function seedSessionWithUsage(harness: Harness, inputTokens: number): void {
	const model = harness.getModel();
	const assistant: AgentMessage = {
		role: "assistant",
		content: [{ type: "text", text: "done ".repeat(80_000) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: inputTokens,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "big session" }],
		timestamp: Date.now() - 1_000,
	});
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

const BIG_MODEL = { id: "faux-big", contextWindow: 1_000_000, maxTokens: 16_384 };
const SMALL_MODEL = { id: "faux-small", contextWindow: 100_000, maxTokens: 16_384 };

describe("model window shrink speculative warm start", () => {
	it("refuses an oversized window shrink before speculative work or model mutation", async () => {
		// given
		const harness = await createHarness({
			models: [BIG_MODEL, SMALL_MODEL],
			extensionFactories: [compactionExtension],
		});
		harnesses.push(harness);
		seedSessionWithUsage(harness, 600_000);
		const smallModel = harness.getModel("faux-small");
		if (!smallModel) throw new Error("faux-small not registered");
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: smallModel }]);

		// when
		const switchPromise = harness.session.cycleModel();

		// then
		await expect(switchPromise).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(harness.session.model?.id).toBe("faux-big");
		expect(harness.faux.state.callCount).toBe(0);
	});
});
