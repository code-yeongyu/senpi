import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_OVERFLOW_BLOCKED_REASON } from "../../../src/core/extensions/builtin/goal/continuation-recovery.ts";
import { readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

// Issue #1422: a turn ended by a provider context overflow that recovery did not
// fix used to be re-prompted as an ordinary provider failure - three identical
// rejections in 30s until the user aborted. The same context cannot succeed
// twice, so the goal must block mechanically and wait for the user.

const OVERFLOW_ERROR =
	"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.";

async function createActiveGoal(ctx: ExtensionContext, harness: ReturnType<typeof createGoalHarness>): Promise<void> {
	await harness.tools
		.get("create_goal")
		?.execute("c1", { objective: "Finish the migration" }, undefined, undefined, ctx);
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
}

describe("#1422 goal continuation after an unrecovered context overflow", () => {
	afterEach(async () => {
		await cleanupGoalMonitorTempDirs();
	});

	it("blocks the goal instead of re-prompting the overflowed context", async () => {
		//#given - an active goal whose turn was rejected by the provider as a context overflow
		const harness = createGoalHarness();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-context-overflow");
		await createActiveGoal(ctx, harness);
		const overflow = fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR });

		//#when - the turn ends without a retry and the session settles
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [overflow], willRetry: false },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		//#then - no continuation is queued and the goal is mechanically blocked with a resumable reason
		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			status: "blocked",
			blockedReason: CONTEXT_OVERFLOW_BLOCKED_REASON,
		});
		expect(notices).toEqual([
			`Goal continuation blocked: ${CONTEXT_OVERFLOW_BLOCKED_REASON}. Send any message to resume.`,
		]);

		//#then - a later settlement does not revive the doomed continuation either
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		expect(harness.sent).toHaveLength(0);
	});

	it("still queues one recovery for an ordinary provider error", async () => {
		//#given
		const harness = createGoalHarness();
		const ctx = await makeGoalContext([], "thread-provider-error");
		await createActiveGoal(ctx, harness);
		const overloaded = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "server_is_overloaded: Our servers are currently overloaded. Please try again later.",
		});

		//#when
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{ type: "agent_end", messages: [overloaded], willRetry: false },
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		//#then - the transient failure keeps its single provider-recovery continuation
		expect(harness.sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
	});
});
