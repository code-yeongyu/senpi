import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

const models = [
	{ id: "roomy", reasoning: true, contextWindow: 200_000, maxTokens: 4_000 },
	{ id: "smaller", reasoning: true, contextWindow: 100_000, maxTokens: 4_000 },
];

// senpi#3839: switching startup models must not borrow the previous model's level.
describe("per-model thinking at resumed startup", () => {
	it.each([
		{ stored: "high", explicit: undefined, expected: "high", source: "session" },
		{ stored: undefined, explicit: undefined, expected: "medium", source: "global" },
		{ stored: "high", explicit: "minimal", expected: "minimal", source: "explicit" },
	] satisfies {
		stored: ThinkingLevel | undefined;
		explicit: ThinkingLevel | undefined;
		expected: ThinkingLevel;
		source: string;
	}[])(
		"uses $expected from $source even though the branch last ran at low",
		async ({ stored, explicit, expected, source }) => {
			const harness = await createHarness({ models });
			try {
				const [target, lastModel] = harness.models;
				if (!lastModel) throw new Error("missing second faux model");
				const { sessionManager, settingsManager, modelRegistry, authStorage } = harness;
				settingsManager.setModelThinkingLevel(target.provider, target.id, "medium");
				sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
				if (stored !== undefined) {
					sessionManager.appendThinkingLevelChange(
						stored,
						{ level: stored, source: "explicit" },
						undefined,
						target,
					);
				}
				sessionManager.appendModelChange(lastModel.provider, lastModel.id);
				sessionManager.appendThinkingLevelChange("low", { level: "low", source: "explicit" }, undefined, lastModel);

				const { session } = await createAgentSession({
					cwd: harness.tempDir,
					agentDir: join(harness.tempDir, "agent"),
					model: target,
					thinkingLevel: explicit,
					modelRegistry,
					modelRuntime: modelRegistry.modelRuntime,
					authStorage,
					sessionManager,
					settingsManager,
					resourceLoader: createTestResourceLoader(),
				});
				try {
					expect(session.model?.id).toBe(target.id);
					expect(session.thinkingLevel).toBe(expected);
					expect(session.thinkingSelection).toEqual({ level: expected, source: "explicit" });
					expect(session.thinkingLevelSource).toBe(source);
				} finally {
					session.dispose();
				}
			} finally {
				harness.cleanup();
			}
		},
	);
});

// senpi#3839: model_select can grow the prompt after the first admission check passed.
describe("favorite cycle rollback after model_select", () => {
	it.each([
		{ outcome: "held", prompt: "large ".repeat(34_000) },
		{ outcome: "rejected", prompt: "large ".repeat(100_000) },
	])("restores the original thinking state when the cycle is $outcome", async ({ outcome, prompt }) => {
		const harness = await createHarness({
			models,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => (event.model.id === "smaller" ? { systemPrompt: prompt } : undefined));
				},
			],
		});
		try {
			const [current, target] = harness.models;
			if (!target) throw new Error("missing smaller faux model");
			const { session, sessionManager, settingsManager } = harness;
			session.setFavoriteModels([{ model: current }, { model: target }]);
			session.setSessionThinkingLevel("high");
			settingsManager.setModelThinkingLevel(target.provider, target.id, "low");
			sessionManager.appendMessage({
				role: "user",
				content: "context ".repeat(21_000),
				timestamp: Date.now(),
			});
			session.agent.state.messages = sessionManager.buildSessionContext().messages;
			const before = sessionManager.getBranch().length;

			const cycle = session.cycleModel();
			if (outcome === "held") {
				const result = await cycle;
				expect(session.pendingModelSwitch?.model.id).toBe(target.id);
				expect(result).toMatchObject({ model: current, thinkingLevel: "high" });
			} else {
				await expect(cycle).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
				expect(session.pendingModelSwitch).toBeUndefined();
			}

			expect(session.model?.id).toBe(current.id);
			expect(session.thinkingLevel).toBe("high");
			expect(session.thinkingSelection).toEqual({ level: "high", source: "explicit" });
			expect(session.thinkingLevelSource).toBe("explicit");
			expect(
				sessionManager
					.getBranch()
					.slice(before)
					.filter((entry) => entry.type === "model_change" || entry.type === "thinking_level_change"),
			).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});
