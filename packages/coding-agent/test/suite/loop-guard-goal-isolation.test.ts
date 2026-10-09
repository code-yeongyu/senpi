import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { didAgentEndCleanly } from "../../src/core/extensions/builtin/goal/continuation.ts";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import { isRecord } from "../../src/core/extensions/builtin/goal/types.ts";
import { buildLoopGuardBlockReason } from "../../src/core/extensions/builtin/loop-guard/notice.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

afterEach(async () => {
	vi.useRealTimers();
	await cleanupGoalMonitorTempDirs();
});

describe("loop-guard Goal isolation", () => {
	it("treats a Tier-2 loop-guard block after a clean stop as a clean agent end", () => {
		const blockResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "todo-loop",
			toolName: "todo",
			content: [{ type: "text", text: buildLoopGuardBlockReason("todo", 1) }],
			isError: true,
			timestamp: 1,
		};
		const messages = [cleanAssistantStop(), blockResult];

		// A loop-guard block result after a clean stop is still a clean end; the pending-wake gate is
		// evaluateGoalContinuation's (goal-continuation-verdict.test.ts).
		expect(didAgentEndCleanly(messages)).toBe(true);
	});

	it("keeps an active Goal active while the loop-guard wake source owns recovery", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-loop-guard-system-abort", {
			pendingMessages: false,
			goalBackstopMaxSeconds: 240,
		});
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		await harness.tools
			.get("create_goal")
			?.execute(
				"create",
				{ objective: "Recover from loop guard" },
				undefined,
				undefined,
				ctx as ExtensionToolContext,
			);
		harness.events.emit("continuation_hold_state", {
			source: "loop-guard-hard-stop",
			active: true,
		});
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "loop-guard-hard-stop",
			activeCount: 1,
		});
		await harness.events.flush();
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);

		await runGoalHandlers(
			harness.handlers,
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
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
		expect(harness.sent).toHaveLength(0);
		const scheduled = harness.events.emitted.find(({ channel }) => channel === "goal_continuation_scheduled");
		expect(scheduled?.data).toMatchObject({
			activeMonitorCount: 1,
			wakeSources: { "loop-guard-hard-stop": 1 },
		});
		if (!isRecord(scheduled?.data) || typeof scheduled.data.delayMs !== "number") {
			throw new Error("goal schedule did not expose delayMs");
		}
		await vi.advanceTimersByTimeAsync(scheduled.data.delayMs + 1);
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.sent).toHaveLength(0);
		harness.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "loop-guard-hard-stop",
			activeCount: 0,
		});
		harness.events.emit("continuation_hold_state", {
			source: "loop-guard-hard-stop",
			active: false,
		});
		await harness.events.flush();
		await runGoalHandlers(harness.handlers, "session_shutdown", { type: "session_shutdown" }, ctx);
	});

	it("does not append a stale-goal reminder to a blocked todo error", async () => {
		const notices: string[] = [];
		const harness = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-loop-guard-todo-error");
		const results: unknown[] = [];
		for (const handler of harness.handlers.get("tool_result") ?? []) {
			results.push(
				await handler(
					{
						type: "tool_result",
						toolCallId: "todo-loop",
						toolName: "todo",
						input: { op: "init" },
						content: [{ type: "text", text: buildLoopGuardBlockReason("todo", 1) }],
						details: {
							op: "init",
							phases: [
								{
									name: "Build",
									tasks: [{ content: "Continue", status: "pending" }],
								},
							],
							storage: "memory",
						},
						isError: true,
					},
					ctx,
				),
			);
		}

		expect(results).toEqual([undefined]);
	});
});
