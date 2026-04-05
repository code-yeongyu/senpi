import type { ExtensionAPI } from "../../types.js";
import type { BackgroundTask } from "./types.js";

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

function getResultPreview(result: string | undefined): string | undefined {
	if (!result) {
		return undefined;
	}

	const normalized = result.trim();
	if (!normalized) {
		return undefined;
	}

	if (normalized.length <= 200) {
		return normalized;
	}

	return `${normalized.slice(0, 200)}...`;
}

export function formatCompletionNotification(task: BackgroundTask): string {
	const lines = [
		`Background task completed: ${task.description} (${task.id})`,
		`Duration: ${formatDuration(task.startedAt, task.completedAt)}`,
		`Status: ${task.status}`,
	];

	if (task.status === "completed") {
		const preview = getResultPreview(task.result);
		if (preview) {
			lines.push(`Result preview: ${preview}`);
		}
	}

	if (task.status === "error" && task.error) {
		lines.push(`Error: ${task.error}`);
	}

	return lines.join("\n");
}

export function sendCompletionNotification(pi: ExtensionAPI, task: BackgroundTask): void {
	const message = formatCompletionNotification(task);
	pi.sendMessage(
		{
			customType: "background-task.complete",
			display: true,
			content: [{ type: "text", text: message }],
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
