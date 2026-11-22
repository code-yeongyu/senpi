import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";
import { createHarness, type Harness } from "../harness.ts";

const realHarnesses: Harness[] = [];

describe("goal creation continuation", () => {
	afterEach(async () => {
		vi.useRealTimers();
		for (const harness of realHarnesses.splice(0)) harness.cleanup();
		await cleanupGoalMonitorTempDirs();
	});

	it("continues immediately when create_goal is the final action of a user turn", async () => {
		vi.useFakeTimers();
		const harness = createGoalHarness();
		const ctx = await makeGoalContext([], "thread-goal-created-final-action");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		await runGoalHandlers(harness.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);

		await harness.tools
			.get("create_goal")
			?.execute("create", { objective: "Ship the release" }, undefined, undefined, ctx as ExtensionToolContext);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStop()] },
			ctx,
		);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("starts the hidden continuation through the real AgentSession", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		realHarnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Ship the release" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("goal registered"),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("goal complete"),
		]);

		await harness.session.prompt("create the release goal and pursue it");

		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "goal-continuation"),
		).toBe(true);
	}, 20_000);
});
