import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoal, readGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { TodoOwedBackstop } from "../../../src/core/extensions/builtin/goal/todo-owed-backstop.ts";
import { goalStatusText } from "../../../src/core/extensions/builtin/goal/ui.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	createGoalStatusHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await cleanupGoalMonitorTempDirs();
});

describe("senpi#3014 stop publication cannot skip goal lifecycle cleanup", () => {
	it.each([
		["stale", "goal-continuation-stopped"],
		["stale", "engine-paused"],
		["cap", "goal-continuation-stopped"],
	] as const)("keeps %s cleanup and the todo backstop when %s throws", async (reason, failedEntry) => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const backstop = vi.spyOn(TodoOwedBackstop.prototype, "afterAgentEnd");
		const attempted: string[] = [];
		const harness = createGoalHarness((customType) => {
			attempted.push(customType);
			if (customType === failedEntry) throw new Error("Entry publication refused");
		});
		const status = createGoalStatusHarness();
		const base = await makeGoalContext([], "3014-goal-stop", { pendingMessages: false, status });
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
		const ctx: ExtensionContext = {
			...base,
			agentDir: base.cwd,
			mode: "tui",
			isProjectTrusted: () => false,
			sessionManager: { ...base.sessionManager, getBranch: () => branch },
		};
		const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
		const created = await createGoal(ref, "Finish work");
		await writeGoal(ref, {
			...created,
			timeUsedSeconds: 7,
			consecutiveContinuations: reason === "cap" ? 8 : 2,
			lastContinuationSignature: `${created.id}:1/1:811c9dc5`,
		});
		await runGoalHandlers(harness.handlers, "agent_start", {}, ctx);
		await vi.advanceTimersByTimeAsync(5_000);
		let failure: unknown;
		try {
			await runGoalHandlers(harness.handlers, "agent_end", { messages: [fauxAssistantMessage("")] }, ctx);
		} catch (error) {
			failure = error;
		}
		const stopped = await readGoal(ref);
		if (!stopped) throw new Error("Expected stopped goal");
		const rendered = status.updates.at(-1);
		const renders = status.updates.length;
		const timers = vi.getTimerCount();
		await vi.advanceTimersByTimeAsync(600_000);
		const rendersAfterStop = status.updates.length;
		await runGoalHandlers(harness.handlers, "session_shutdown", {}, ctx);

		// The rejected append must not leave the in-process accounting window open (12 -> 612 before fix).
		expect(stopped.timeUsedSeconds).toBe(12);
		expect((await readGoal(ref))?.timeUsedSeconds).toBe(12);
		expect(failure).toBeUndefined();
		expect(timers).toBe(0);
		expect(rendersAfterStop).toBe(renders);
		expect(rendered).toEqual({ key: "goal", text: goalStatusText(stopped) });
		expect(backstop).toHaveBeenCalledTimes(1);
		expect(backstop).toHaveBeenCalledWith(expect.objectContaining({ goal: stopped }));
		expect(attempted).toEqual(
			reason === "stale" ? ["goal-continuation-stopped", "engine-paused"] : ["goal-continuation-stopped"],
		);
		if (reason === "cap") {
			expect(stopped).toMatchObject({ status: "blocked", blockedReason: "continuation cap reached" });
			expect(harness.sent.map((item) => item.message.customType)).toEqual(["senpi.todo-owed"]);
		} else {
			expect(stopped.lastStartedAt).toBeUndefined();
			expect(harness.sent).toEqual([]);
		}
		const records: unknown[] = (await readFile(join(ctx.agentDir, "logs", "session.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toContainEqual(
			expect.objectContaining({
				level: "warn",
				event: "goal_continuation_record_write_failed",
				kind: failedEntry,
				error: expect.any(String),
			}),
		);
	});
});
