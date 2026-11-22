import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

// oh-my-openagent#11684 (fix lands in senpi per maintainer triage: the count
// lives in the engine's `getContextUsage`): after a mid-session model switch,
// the status line kept showing the previous model's token count against the
// new model's window until the new model reported usage. The 304K figure in
// the issue is the last Claude turn's usage shown against GPT's 500K window.
describe("context usage after a mid-session model switch", () => {
	it("estimates from content instead of showing the previous model's count", async () => {
		const harness = await createHarness({
			models: [
				{ id: "model-a", contextWindow: 1_000_000 },
				{ id: "model-b", contextWindow: 500_000 },
			],
		});
		try {
			const modelA = harness.getModel("model-a");
			const modelB = harness.getModel("model-b");
			if (!modelA || !modelB) throw new Error("faux models missing");
			harness.agent.state.model = modelA;
			const user: UserMessage = { role: "user", content: "0123456789", timestamp: 1 };
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "0123456789" }],
				api: modelA.api,
				provider: modelA.provider,
				model: modelA.id,
				usage: {
					input: 875,
					output: 0,
					cacheRead: 303_182,
					cacheWrite: 0,
					totalTokens: 304_057,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			};
			harness.sessionManager.appendMessage(user);
			harness.sessionManager.appendMessage(assistant);
			harness.agent.state.messages = [user, assistant];

			// Before the switch, the reported usage describes the context.
			const before = harness.session.getContextUsage();
			expect(before?.tokens).toBe(304_057);
			expect(before?.contextWindow).toBe(1_000_000);
			expect(before?.percent).toBeCloseTo(30.4057, 4);

			// The picker switch: a `model_change` entry lands, the new model is
			// active, and no new-model turn has reported usage yet.
			harness.sessionManager.appendModelChange(modelB.provider, modelB.id);
			harness.agent.state.model = modelB;

			// The stale 304,057 (previous model's tokenizer) must not be shown
			// against the 500K window (60.8%). Content estimate at 4 chars/token:
			// 10 chars user + 10 chars assistant = 3 + 3 = 6 tokens.
			const stale = harness.session.getContextUsage();
			expect(stale?.tokens).toBe(6);
			expect(stale?.tokens).not.toBe(304_057);
			expect(stale?.contextWindow).toBe(500_000);

			// Once the new model reports usage, reported accounting resumes.
			const followUp: AssistantMessage = {
				...assistant,
				content: [{ type: "text", text: "0123456789" }],
				model: modelB.id,
				usage: {
					input: 167_805,
					output: 0,
					cacheRead: 3_968,
					cacheWrite: 0,
					totalTokens: 171_957,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 3,
			};
			harness.sessionManager.appendMessage(followUp);
			harness.agent.state.messages = [user, assistant, followUp];
			const after = harness.session.getContextUsage();
			expect(after?.tokens).toBe(171_957);
			expect(after?.contextWindow).toBe(500_000);
		} finally {
			harness.cleanup();
		}
	});
});
