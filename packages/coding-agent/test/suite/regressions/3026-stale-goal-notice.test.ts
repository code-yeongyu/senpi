import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoal, readGoal, updateGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await cleanupGoalMonitorTempDirs();
});

async function fixture() {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	const notices: string[] = [];
	const harness = createGoalHarness();
	const base = await makeGoalContext(notices, "3026-stale-goal");
	const ctx: ExtensionToolContext = {
		...base,
		agentDir: base.cwd,
		mode: "tui",
		tools: [],
		executeTool: async () => {
			throw new Error("Unexpected nested tool execution");
		},
	};
	const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
	const goal = await createGoal(ref, "Finish the work");
	await writeGoal(ref, {
		...goal,
		consecutiveContinuations: 2,
		lastContinuationSignature: `${goal.id}:0/0:811c9dc5`,
	});
	return { harness, ctx, ref, notices };
}

describe("senpi#3026 stale goal recovery notices", () => {
	it("notifies once at the stale stop despite repeated denial and rendering", async () => {
		const f = await fixture();
		await runGoalHandlers(f.harness.handlers, "agent_start", {}, f.ctx);
		await runGoalHandlers(f.harness.handlers, "agent_end", { messages: [cleanAssistantStop()] }, f.ctx);
		await runGoalHandlers(f.harness.handlers, "agent_end", { messages: [cleanAssistantStop()] }, f.ctx);
		await f.harness.tools.get("get_goal")?.execute("inspect", {}, undefined, undefined, f.ctx);
		const stopped = await readGoal(f.ref);
		await runGoalHandlers(f.harness.handlers, "session_shutdown", {}, f.ctx);

		expect(stopped?.continuationStoppedAt).toBe(1_000_000);
		expect(f.harness.sent).toHaveLength(0);
		expect(f.notices).toHaveLength(1);
		expect(f.notices[0]).toContain("/goal resume");
	});

	it.each(["startup", "resume"] as const)(
		"notifies once on %s, but not on reload or for active, paused, or completed goals",
		async (reason) => {
			const f = await fixture();
			// Controls share the same event boundary; a normal active goal must not earn this notice.
			await runGoalHandlers(f.harness.handlers, "session_start", { reason }, f.ctx);
			await runGoalHandlers(f.harness.handlers, "session_shutdown", {}, f.ctx);
			const paused = await updateGoal(f.ref, { status: "paused" }, "user");
			for (const status of ["paused", "complete"] as const) {
				await writeGoal(f.ref, { ...paused, status });
				const other = createGoalHarness();
				await runGoalHandlers(other.handlers, "session_start", { reason }, f.ctx);
				await runGoalHandlers(other.handlers, "session_shutdown", {}, f.ctx);
			}
			expect(f.notices).toHaveLength(0);

			const stopped = { ...paused, status: "active" as const, continuationStoppedAt: Date.now() };
			await writeGoal(f.ref, stopped);
			const reopened = createGoalHarness();
			// A stale stop also supersedes the older flood notice, even with a long history.
			const floodCtx: ExtensionToolContext = {
				...f.ctx,
				sessionManager: {
					...f.ctx.sessionManager,
					getBranch: () =>
						Array.from({ length: 8 }, (_, index) => ({
							type: "custom_message" as const,
							id: `continuation-${index}`,
							parentId: null,
							timestamp: new Date().toISOString(),
							customType: "goal-continuation",
							content: "continue",
							display: false,
						})),
				},
			};
			await runGoalHandlers(reopened.handlers, "session_start", { reason }, floodCtx);
			await reopened.tools.get("get_goal")?.execute("inspect", {}, undefined, undefined, floodCtx);
			await runGoalHandlers(reopened.handlers, "session_shutdown", {}, floodCtx);
			// Reload rebuilds the extension, so an instance-local latch would not prevent duplicates.
			const reloaded = createGoalHarness();
			await runGoalHandlers(reloaded.handlers, "session_start", { reason: "reload" }, f.ctx);
			await runGoalHandlers(reloaded.handlers, "session_shutdown", {}, f.ctx);

			expect(await readGoal(f.ref)).toEqual(stopped);
			expect(reopened.sent).toHaveLength(0);
			expect(reloaded.sent).toHaveLength(0);
			expect(f.notices).toHaveLength(1);
			expect(f.notices[0]).toContain("/goal resume");
		},
	);

	it("notifies once per reopen when the same stopped session is opened twice", async () => {
		const f = await fixture();
		const goal = await readGoal(f.ref);
		if (!goal) throw new Error("Expected goal");
		const stopped = { ...goal, continuationStoppedAt: Date.now() };
		delete stopped.lastStartedAt;
		await writeGoal(f.ref, stopped);
		await runGoalHandlers(f.harness.handlers, "session_shutdown", {}, f.ctx);
		for (let open = 0; open < 2; open++) {
			const reopened = createGoalHarness();
			await runGoalHandlers(reopened.handlers, "session_start", { reason: "resume" }, f.ctx);
			await runGoalHandlers(reopened.handlers, "session_shutdown", {}, f.ctx);
			expect(reopened.sent).toHaveLength(0);
			expect(f.notices).toHaveLength(open + 1);
		}
		expect(await readGoal(f.ref)).toEqual(stopped);
	});
});
