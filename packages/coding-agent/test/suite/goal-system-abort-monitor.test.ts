import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal, recordContinuationDelivered } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	createGoalStatusHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

describe("goal state after a system-owned abort", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it.each(["aborted", "error"] as const)(
		"keeps the Goal active and monitor wait armed after a terminal %s system abort",
		async (stopReason) => {
			vi.useFakeTimers();
			const notices: string[] = [];
			const harness = createGoalHarness();
			const { tools, handlers, sent, events } = harness;
			const ctx = await makeGoalContext(notices, "thread-system-abort-monitor");
			await tools.get("create_goal")?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
			await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
			events.emit("terminal_monitor_state", { activeCount: 1 });
			await events.flush();
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);

			await runGoalHandlers(
				handlers,
				"agent_end",
				{
					type: "agent_end",
					aborted: true,
					abortSource: "system",
					willRetry: false,
					messages: [{ ...cleanAssistantStop(), stopReason }],
				},
				ctx,
			);

			expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
			expect(sent).toHaveLength(0);
			expect(events.emitted).toContainEqual({
				channel: "goal_continuation_scheduled",
				data: expect.objectContaining({ activeMonitorCount: 1, delayMs: 240_000 }),
			});
		},
	);

	it("queues Goal-owned recovery for a terminal system error without monitors", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const { tools, handlers, sent } = harness;
		const ctx = await makeGoalContext(notices, "thread-system-error-no-monitor");
		await tools
			.get("create_goal")
			?.execute("create", { objective: "Recover without a monitor" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);

		await runGoalHandlers(
			handlers,
			"agent_end",
			{
				type: "agent_end",
				aborted: true,
				abortSource: "system",
				willRetry: false,
				messages: [{ ...cleanAssistantStop(), stopReason: "error" as const }],
			},
			ctx,
		);

		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
		expect(sent).toHaveLength(0);
		await runGoalHandlers(handlers, "agent_settled", { type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("refreshes blocked Goal status when settlement recovery hits the cap", async () => {
		const notices: string[] = [];
		const status = createGoalStatusHarness();
		const { tools, handlers } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-system-error-cap", { pendingMessages: false, status });
		await tools
			.get("create_goal")
			?.execute("create", { objective: "Stop at the continuation cap" }, undefined, undefined, ctx);
		const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
		for (let attempt = 0; attempt < 8; attempt++) {
			await recordContinuationDelivered(ref, `signature-${attempt}`);
		}
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{
				type: "agent_end",
				aborted: true,
				abortSource: "system",
				willRetry: false,
				messages: [{ ...cleanAssistantStop(), stopReason: "error" as const }],
			},
			ctx,
		);
		await runGoalHandlers(handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(await readGoal(ref)).toMatchObject({ status: "blocked" });
		expect(status.updates.at(-1)?.text).toContain("Goal blocked");
	});
});
