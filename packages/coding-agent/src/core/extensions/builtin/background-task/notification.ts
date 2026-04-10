import type { ExtensionAPI } from "../../types.js";
import { sendBuiltinCustomMessage } from "../system-messages.js";
import type { BackgroundManager } from "./manager.js";
import type { BackgroundTask } from "./types.js";

export type NotificationStatus = "COMPLETED" | "CANCELLED" | "ERROR";

export interface NotificationTask {
	id: string;
	description: string;
	status: BackgroundTask["status"];
	error?: string;
	result?: string;
}

export interface NotificationInput {
	task: NotificationTask;
	duration: string;
	statusText: NotificationStatus;
	allComplete: boolean;
	remainingCount: number;
	completedTasks: NotificationTask[];
}

function safeDescription(task: NotificationTask): string {
	return task.description || task.id;
}

export function formatCompletionNotification(input: NotificationInput): string {
	const { task, duration, statusText, allComplete, remainingCount, completedTasks } = input;
	const errorInfo = task.error ? `\n**Error:** ${task.error}` : "";

	if (allComplete) {
		return formatAllCompleteNotification(task, completedTasks);
	}

	const isFailure = statusText !== "COMPLETED";

	return `<system-reminder>
[BACKGROUND TASK ${statusText}]
**ID:** \`${task.id}\`
**Description:** ${safeDescription(task)}
**Duration:** ${duration}${errorInfo}

**${remainingCount} task${remainingCount === 1 ? "" : "s"} still in progress.** You WILL be notified when ALL complete.
${isFailure ? "**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue." : "Do NOT poll - continue productive work."}

Use \`background_output(task_id="${task.id}")\` to retrieve this result when ready.
</system-reminder>`;
}

function formatAllCompleteNotification(task: NotificationTask, completedTasks: NotificationTask[]): string {
	const succeededTasks = completedTasks.filter((t) => t.status === "completed");
	const failedTasks = completedTasks.filter((t) => t.status !== "completed");

	const succeededText =
		succeededTasks.length > 0 ? succeededTasks.map((t) => `- \`${t.id}\`: ${safeDescription(t)}`).join("\n") : "";
	const failedText =
		failedTasks.length > 0
			? failedTasks
					.map(
						(t) =>
							`- \`${t.id}\`: ${safeDescription(t)} [${t.status.toUpperCase()}]${t.error ? ` - ${t.error}` : ""}`,
					)
					.join("\n")
			: "";

	const hasFailures = failedTasks.length > 0;
	const header = hasFailures
		? `[ALL BACKGROUND TASKS FINISHED - ${failedTasks.length} FAILED]`
		: "[ALL BACKGROUND TASKS COMPLETE]";

	let body = "";
	if (succeededText) {
		body += `**Completed:**\n${succeededText}\n`;
	}
	if (failedText) {
		body += `\n**Failed:**\n${failedText}\n`;
	}
	if (!body) {
		body = `- \`${task.id}\`: ${safeDescription(task)} [${task.status.toUpperCase()}]${task.error ? ` - ${task.error}` : ""}\n`;
	}

	return `<system-reminder>
${header}

${body.trim()}

Use \`background_output(task_id="<id>")\` to retrieve each result.${hasFailures ? `\n\n**ACTION REQUIRED:** ${failedTasks.length} task(s) failed. Check errors above and decide whether to retry or proceed.` : ""}
</system-reminder>`;
}

function formatDuration(startedAt: Date, completedAt: Date | undefined): string {
	const end = completedAt ?? new Date();
	const milliseconds = end.getTime() - startedAt.getTime();
	if (milliseconds < 1000) {
		return `${milliseconds}ms`;
	}
	if (milliseconds < 60000) {
		return `${(milliseconds / 1000).toFixed(1)}s`;
	}
	return `${Math.floor(milliseconds / 60000)}m ${Math.floor((milliseconds % 60000) / 1000)}s`;
}

function mapStatus(task: BackgroundTask): NotificationStatus {
	switch (task.status) {
		case "cancelled":
			return "CANCELLED";
		case "error":
			return "ERROR";
		default:
			return "COMPLETED";
	}
}

function isTerminalStatus(status: BackgroundTask["status"]): boolean {
	return status === "completed" || status === "error" || status === "cancelled";
}

export function sendCompletionNotification(pi: ExtensionAPI, task: BackgroundTask, manager: BackgroundManager): void {
	const activeTasks = manager.getActiveTasks();
	const allComplete = activeTasks.length === 0;
	const remainingCount = activeTasks.length;

	const completedTasks: NotificationTask[] = allComplete
		? manager
				.getAllTasks()
				.filter((t) => isTerminalStatus(t.status))
				.map((t) => ({ id: t.id, description: t.description, status: t.status, error: t.error, result: t.result }))
		: [];

	const duration = formatDuration(task.startedAt, task.completedAt);
	const statusText = mapStatus(task);

	const message = formatCompletionNotification({
		task: { id: task.id, description: task.description, status: task.status, error: task.error, result: task.result },
		duration,
		statusText,
		allComplete,
		remainingCount,
		completedTasks,
	});

	sendBuiltinCustomMessage(
		pi,
		"background-task.notification",
		{
			customType: "background-task.complete",
			display: true,
			content: [{ type: "text", text: message }],
		},
		{ triggerTurn: true, deliverAs: "followUp", sessionId: task.parentSessionId },
	);
}
