import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createGoal, readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	createGoalStatusHarness,
	makeGoalContext,
	runGoalHandlers,
	type AppendedGoalEntry,
	type GoalHarness,
} from "../goal-monitor-test-harness.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await cleanupGoalMonitorTempDirs();
});

/** Session entries for stop entries an earlier turn appended, as a reopened session would read them. */
function toBranchEntries(entries: readonly AppendedGoalEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({
		type: "custom",
		id: `appended-${index}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: entry.customType,
		data: entry.data,
	})) as SessionEntry[];
}

async function driveStaleStop(ctx: ExtensionContext, harness: GoalHarness) {
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "open-todo",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: "todo-1",
				content: [{ type: "text", text: "registered" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					op: "init",
					phases: [{ name: "Build", tasks: [{ content: "Finish work", status: "in_progress" }] }],
					storage: "memory",
				},
			},
		},
	];
	const sessionCtx: ExtensionContext = {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getBranch: () => branch },
	};
	const ref = goalStoreRef(sessionCtx.sessionManager, sessionCtx.cwd);
	const created = await createGoal(ref, "Finish work");
	await writeGoal(ref, {
		...created,
		timeUsedSeconds: 7,
		consecutiveContinuations: 2,
		lastContinuationSignature: `${created.id}:1/1:811c9dc5`,
	});
	await runGoalHandlers(harness.handlers, "agent_start", {}, sessionCtx);
	await vi.advanceTimersByTimeAsync(5_000);
	await runGoalHandlers(harness.handlers, "agent_end", { messages: [fauxAssistantMessage("")] }, sessionCtx);
	return { ref, branch, sessionCtx };
}

describe("senpi#3015 crashed stop claim recovers its session entries on reopen", () => {
	it("re-appends exactly one stop entry and one engine-paused entry after a crash between the claim and the append", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		let crashed = true;
		const entries: AppendedGoalEntry[] = [];
		const harness = createGoalHarness((customType, data) => {
			if (crashed && (customType === "goal-continuation-stopped" || customType === "engine-paused")) {
				throw new Error("process died before the append landed");
			}
			entries.push({ customType, data });
		});
		const status = createGoalStatusHarness();
		const base = await makeGoalContext([], "3015-goal-stop", { pendingMessages: false, status });
		const ctx: ExtensionContext = { ...base, agentDir: base.cwd, mode: "tui", isProjectTrusted: () => false };
		const { ref, branch, sessionCtx } = await driveStaleStop(ctx, harness);

		// The crash left the claim without its entries.
		// Fake time advanced 5s during the turn, so the claim lands at 1_005_000.
		const claimed = await readGoal(ref);
		const at = claimed?.continuationStoppedAt;
		expect(at).toBe(1_005_000);
		expect(claimed?.continuationStoppedDetail).toEqual({
			reason: "stale",
			consecutiveContinuations: 2,
			unattendedContinuations: 0,
			noProgressContinuations: 0,
		});
		expect(entries.filter((entry) => entry.customType === "goal-continuation-stopped")).toEqual([]);
		expect(entries.filter((entry) => entry.customType === "engine-paused")).toEqual([]);

		// Reopen in a new process: appends work again, the branch still lacks the entries.
		crashed = false;
		await runGoalHandlers(harness.handlers, "session_start", { reason: "startup" }, sessionCtx);
		const stops = entries.filter((entry) => entry.customType === "goal-continuation-stopped");
		const pauses = entries.filter((entry) => entry.customType === "engine-paused");
		expect(stops).toHaveLength(1);
		expect(pauses).toHaveLength(1);
		expect(stops[0]?.data).toEqual({
			goalId: claimed?.id,
			reason: "stale",
			consecutiveContinuations: 2,
			unattendedContinuations: 0,
			noProgressContinuations: 0,
			at,
		});
		expect(pauses[0]?.data).toEqual({
			reason: "goal-stale",
			customType: "goal-continuation",
			count: 2,
			at,
		});

		// A second reopen sees the recovered entries in the branch and appends nothing more.
		branch.push(...toBranchEntries(entries));
		const countBefore = entries.length;
		await runGoalHandlers(harness.handlers, "session_start", { reason: "startup" }, sessionCtx);
		expect(entries.length).toBe(countBefore);
		await runGoalHandlers(harness.handlers, "session_shutdown", {}, sessionCtx);
	});

	it("does not duplicate the stop entries when both writes had succeeded", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const entries: AppendedGoalEntry[] = [];
		const harness = createGoalHarness((customType, data) => {
			entries.push({ customType, data });
		});
		const status = createGoalStatusHarness();
		const base = await makeGoalContext([], "3015-goal-stop-clean", { pendingMessages: false, status });
		const ctx: ExtensionContext = { ...base, agentDir: base.cwd, mode: "tui", isProjectTrusted: () => false };
		const { branch, sessionCtx } = await driveStaleStop(ctx, harness);

		const stops = entries.filter((entry) => entry.customType === "goal-continuation-stopped");
		const pauses = entries.filter((entry) => entry.customType === "engine-paused");
		expect(stops).toHaveLength(1);
		expect(pauses).toHaveLength(1);

		// The reopened session reads the entries the first turn appended.
		branch.push(...toBranchEntries(entries));
		const countBefore = entries.length;
		await runGoalHandlers(harness.handlers, "session_start", { reason: "startup" }, sessionCtx);
		expect(entries.length).toBe(countBefore);
		await runGoalHandlers(harness.handlers, "session_shutdown", {}, sessionCtx);
	});
});
