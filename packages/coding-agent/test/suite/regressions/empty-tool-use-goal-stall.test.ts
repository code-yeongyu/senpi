import { EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

// A provider under upstream overload returned a streamed assistant message whose
// message_delta carried stop_reason "tool_use" while the tool_use content block was
// lost in transit, producing `{ stopReason: "toolUse", content: [thinking] }` with zero
// toolCall blocks. The agent loop saw no tool calls and ended the turn as if it were
// finished, while goal continuation refused to resume anything that ended in "toolUse".
// The two layers disagreed on what a coherent terminal state is, so an active goal froze
// with nothing pending and nothing running until the user noticed and re-prompted.
//
// A malformed terminal message is infrastructure breakage, not a decision by the model or
// the user, so the goal must resume. A turn a tool deliberately ended must still not.

async function createActiveGoal(ctx: ExtensionContext, harness: ReturnType<typeof createGoalHarness>): Promise<void> {
	await harness.tools
		.get("create_goal")
		?.execute("c1", { objective: "Fix the placeholder typo and land the change" }, undefined, undefined, ctx);
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
}

describe("empty tool_use terminal message does not stall an active goal", () => {
	afterEach(async () => {
		await cleanupGoalMonitorTempDirs();
	});

	it("queues a continuation when the provider ends the turn as toolUse with no tool call", async () => {
		//#given - an active goal whose turn ended on a toolUse message that carries no tool call
		const harness = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-empty-tool-use");
		await createActiveGoal(ctx, harness);
		const malformed = fauxAssistantMessage("", { stopReason: "toolUse" });

		//#when
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [malformed], willRetry: false },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		//#then - the goal resumes instead of freezing while still marked active
		expect(harness.sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
	});

	it("queues a continuation after the agent loop demoted the malformed turn to a clean stop", async () => {
		//#given - the loop rewrites the stop reason to "stop" and leaves only the demotion diagnostic
		const harness = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-demoted-tool-use");
		await createActiveGoal(ctx, harness);
		const demoted = {
			...fauxAssistantMessage("", { stopReason: "toolUse" }),
			stopReason: "stop" as const,
			diagnostics: [{ type: EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC, timestamp: 0, details: {} }],
		};

		//#when
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [demoted], willRetry: false },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		//#then - the demotion diagnostic still identifies the turn as provider breakage
		expect(harness.sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
	});

	it("does not queue a continuation for an ordinary clean stop", async () => {
		//#given - an active goal whose turn ended as a plain stop with no demotion diagnostic
		const harness = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-plain-stop");
		await createActiveGoal(ctx, harness);
		const plain = fauxAssistantMessage("all done", { stopReason: "stop" });

		//#when
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [plain], willRetry: false },
			ctx,
		);

		//#then - a clean stop must not be mistaken for provider breakage
		expect(
			harness.sent.filter((entry) => entry.message.customType === "goal-continuation").length,
		).toBeLessThanOrEqual(1);
	});

	it("does not queue a continuation when an executed tool deliberately ended the turn", async () => {
		//#given - an active goal whose turn ended on a toolUse message whose tool call did run
		const harness = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-terminating-tool-use");
		await createActiveGoal(ctx, harness);
		const terminated = fauxAssistantMessage([fauxToolCall("ask_user", { question: "which branch?" })], {
			stopReason: "toolUse",
		});

		//#when
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [terminated], willRetry: false },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		//#then - a deliberate stop keeps its existing behavior and waits for the user
		expect(harness.sent).toHaveLength(0);
	});
});
