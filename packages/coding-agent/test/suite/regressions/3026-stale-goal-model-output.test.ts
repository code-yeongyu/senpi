import { afterEach, describe, expect, it } from "vitest";
import { createGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import { cleanupGoalMonitorTempDirs, createGoalHarness, makeGoalContext } from "../goal-monitor-test-harness.ts";

afterEach(cleanupGoalMonitorTempDirs);

// senpi#3053: inspect the registered get_goal result consumed by the model, not UI copy.
describe("senpi#3026 model-facing stale stop", () => {
	it.each(["active", "paused", "complete", "stale-stopped"] as const)(
		"returns machine-readable continuation state for %s",
		async (state) => {
			const harness = createGoalHarness();
			const base = await makeGoalContext([], "3026-model-output");
			const ctx: ExtensionToolContext = {
				...base,
				agentDir: base.cwd,
				mode: "rpc",
				tools: [],
				executeTool: async () => {
					throw new Error("Unexpected nested tool execution");
				},
			};
			const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
			const goal = await createGoal(ref, "Finish the work");
			await writeGoal(ref, {
				...goal,
				status: state === "stale-stopped" ? "active" : state,
				...(state === "stale-stopped" ? { continuationStoppedAt: 1_000_000 } : {}),
			});
			const tool = harness.tools.get("get_goal");
			if (!tool) throw new Error("Expected registered get_goal");
			const result = await tool.execute("inspect", {}, undefined, undefined, ctx);
			const text = result.content.find((part) => part.type === "text");
			if (text?.type !== "text") throw new Error("Expected model-facing tool text");
			const response: unknown = JSON.parse(text.text);
			if (state === "stale-stopped") {
				expect(response).toMatchObject({
					goal: { status: "paused", continuationStoppedAt: 1_000_000 },
					continuation: { status: "stale_stopped", message: expect.any(String) },
				});
			} else {
				expect(response).toMatchObject({ goal: { status: state } });
				expect(response).not.toHaveProperty("continuation");
			}
		},
	);
});
