import { describe, expect, it, vi } from "vitest";
import {
	formatCompletionNotification,
	type NotificationInput,
	sendCompletionNotification,
} from "../../src/core/extensions/builtin/background-task/notification.js";
import type { BackgroundTask } from "../../src/core/extensions/builtin/background-task/types.js";
import { SANEPI_CONVERSATION_EVENT, SANEPI_SYSTEM_PREFIX } from "../../src/core/extensions/builtin/system-messages.js";

describe("formatCompletionNotification", () => {
	describe("#given one task still running after a completed task notification", () => {
		it("#when building the partial notification #then it includes only lookup materials without result preview", () => {
			// given
			const input: NotificationInput = {
				task: { id: "task-1", description: "Index repo", status: "completed" },
				duration: "42s",
				statusText: "COMPLETED",
				allComplete: false,
				remainingCount: 1,
				completedTasks: [],
			};

			// when
			const notification = formatCompletionNotification(input);

			// then
			expect(notification).toBe(`<system-reminder>
[BACKGROUND TASK COMPLETED]
**ID:** \`task-1\`
**Description:** Index repo
**Duration:** 42s

**1 task still in progress.** You WILL be notified when ALL complete.
Do NOT poll - continue productive work.

Use \`background_output(task_id="task-1")\` to retrieve this result when ready.
</system-reminder>`);
		});
	});

	describe("#given one task still running after a failed task notification", () => {
		it("#when building the partial notification #then it includes error info and action required message", () => {
			// given
			const input: NotificationInput = {
				task: { id: "task-2", description: "Summarize logs", status: "error", error: "Timed out" },
				duration: "3m 4s",
				statusText: "ERROR",
				allComplete: false,
				remainingCount: 2,
				completedTasks: [],
			};

			// when
			const notification = formatCompletionNotification(input);

			// then
			expect(notification).toBe(`<system-reminder>
[BACKGROUND TASK ERROR]
**ID:** \`task-2\`
**Description:** Summarize logs
**Duration:** 3m 4s
**Error:** Timed out

**2 tasks still in progress.** You WILL be notified when ALL complete.
**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue.

Use \`background_output(task_id="task-2")\` to retrieve this result when ready.
</system-reminder>`);
		});
	});

	describe("#given all sibling tasks completed with mixed outcomes", () => {
		it("#when building the final notification #then it shows summary with completed and failed sections", () => {
			// given
			const input: NotificationInput = {
				task: { id: "task-3", description: "Fallback task", status: "error", error: "Denied" },
				duration: "10s",
				statusText: "ERROR",
				allComplete: true,
				remainingCount: 0,
				completedTasks: [
					{ id: "task-1", description: "Index repo", status: "completed" },
					{ id: "task-2", description: "Summarize logs", status: "cancelled", error: "User aborted" },
					{ id: "task-3", description: "Fallback task", status: "error", error: "Denied" },
				],
			};

			// when
			const notification = formatCompletionNotification(input);

			// then
			expect(notification).toBe(`<system-reminder>
[ALL BACKGROUND TASKS FINISHED - 2 FAILED]

**Completed:**
- \`task-1\`: Index repo

**Failed:**
- \`task-2\`: Summarize logs [CANCELLED] - User aborted
- \`task-3\`: Fallback task [ERROR] - Denied

Use \`background_output(task_id="<id>")\` to retrieve each result.

**ACTION REQUIRED:** 2 task(s) failed. Check errors above and decide whether to retry or proceed.
</system-reminder>`);
		});
	});

	describe("#given all tasks completed successfully", () => {
		it("#when building the final notification #then it shows clean completion without action required", () => {
			// given
			const input: NotificationInput = {
				task: { id: "task-2", description: "Analyze code", status: "completed" },
				duration: "15s",
				statusText: "COMPLETED",
				allComplete: true,
				remainingCount: 0,
				completedTasks: [
					{ id: "task-1", description: "Index repo", status: "completed" },
					{ id: "task-2", description: "Analyze code", status: "completed" },
				],
			};

			// when
			const notification = formatCompletionNotification(input);

			// then
			expect(notification).toBe(`<system-reminder>
[ALL BACKGROUND TASKS COMPLETE]

**Completed:**
- \`task-1\`: Index repo
- \`task-2\`: Analyze code

Use \`background_output(task_id="<id>")\` to retrieve each result.
</system-reminder>`);
		});
	});

	describe("#given a single task notification with undefined description", () => {
		it("#when building the partial notification #then it uses task ID as fallback", () => {
			// given
			const input: NotificationInput = {
				task: { id: "bg_xyz789", description: undefined as unknown as string, status: "completed" },
				duration: "3s",
				statusText: "COMPLETED",
				allComplete: false,
				remainingCount: 2,
				completedTasks: [],
			};

			// when
			const notification = formatCompletionNotification(input);

			// then
			expect(notification).not.toContain(": undefined");
			expect(notification).toContain("bg_xyz789");
		});
	});

	describe("#given all tasks completed with undefined descriptions", () => {
		it("#when building the final notification #then it uses task ID as fallback instead of 'undefined'", () => {
			// given
			const input: NotificationInput = {
				task: { id: "bg_abc123", description: undefined as unknown as string, status: "completed" },
				duration: "5s",
				statusText: "COMPLETED",
				allComplete: true,
				remainingCount: 0,
				completedTasks: [
					{ id: "bg_abc123", description: undefined as unknown as string, status: "completed" },
					{ id: "bg_def456", description: undefined as unknown as string, status: "completed" },
				],
			};

			// when
			const notification = formatCompletionNotification(input);

			// then
			expect(notification).not.toContain(": undefined");
			expect(notification).toContain("bg_abc123");
			expect(notification).toContain("bg_def456");
		});
	});

	describe("#given a completed notification with result data available", () => {
		it("#when building the notification #then it never includes result preview text", () => {
			// given
			const input: NotificationInput = {
				task: { id: "task-1", description: "Search codebase", status: "completed" },
				duration: "10s",
				statusText: "COMPLETED",
				allComplete: false,
				remainingCount: 1,
				completedTasks: [],
			};

			// when
			const notification = formatCompletionNotification(input);

			// then
			expect(notification).not.toContain("Result preview");
			expect(notification).not.toContain("Result:");
			expect(notification).toContain("background_output");
		});
	});
});

describe("sendCompletionNotification", () => {
	it("prefixes the injected message and emits sanepi notification events", () => {
		// given
		const sendMessage = vi.fn();
		const emit = vi.fn();
		const pi = {
			sendMessage,
			events: { emit },
		};
		const task: BackgroundTask = {
			id: "bg_1234abcd",
			description: "Analyze code",
			prompt: "Analyze code",
			model: undefined,
			agentType: undefined,
			status: "completed" as const,
			pid: undefined,
			sessionPath: undefined,
			startedAt: new Date("2026-01-01T00:00:00.000Z"),
			completedAt: new Date("2026-01-01T00:00:10.000Z"),
			parentSessionId: "session-1",
			activeToolNames: [],
			result: "done",
			error: undefined,
		};
		const manager = {
			getActiveTasks: () => [],
			getAllTasks: () => [task],
		};

		// when
		sendCompletionNotification(pi as never, task, manager as never);

		// then
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "background-task.complete",
				content: [
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining(`${SANEPI_SYSTEM_PREFIX}\n<system-reminder>`),
					}),
				],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(emit).toHaveBeenCalledWith(
			SANEPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "injected",
				route: "background-task.notification",
				sessionId: "session-1",
				conversation: expect.objectContaining({
					kind: "custom_message",
					customType: "background-task.complete",
					prefix: SANEPI_SYSTEM_PREFIX,
					triggerTurn: true,
					deliverAs: "followUp",
				}),
			}),
		);
	});
});
