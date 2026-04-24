import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "../../types.js";
import type { BackgroundManager } from "./manager.js";

const BackgroundCancelParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "Task ID to cancel (required if all=false)" })),
	all: Type.Optional(Type.Boolean({ description: "Cancel all running background tasks (default: false)" })),
});

export function createBackgroundCancelTool(manager: BackgroundManager): ToolDefinition<typeof BackgroundCancelParams> {
	return {
		name: "background_cancel",
		label: "BackgroundCancel",
		description: "Cancel a background task by taskId, or cancel all running tasks with all=true.",
		promptSnippet: "Cancel background tasks by ID or cancel all running tasks.",
		promptGuidelines: [
			"Use this tool to cancel pending or running background tasks.",
			"Provide taskId to cancel a specific task, or set all=true to cancel all active tasks.",
			"Cancelled tasks will be marked as 'cancelled' and cannot be resumed.",
		],
		parameters: BackgroundCancelParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!params.taskId && !params.all) {
				return {
					content: [{ type: "text", text: "Error: Provide taskId or set all=true" }],
					details: undefined,
					isError: true,
				};
			}

			if (params.all) {
				const cancelled = manager.cancelAll();

				if (cancelled.length === 0) {
					return {
						content: [{ type: "text", text: "No active tasks to cancel" }],
						details: { cancelledTasks: [] },
					};
				}

				for (const task of cancelled) {
					if (task.pid !== undefined) {
						try {
							process.kill(task.pid, "SIGTERM");
						} catch {
							/* process may already be dead */
						}
					}
				}

				const lines: string[] = [`Cancelled ${cancelled.length} task(s):`];
				for (const task of cancelled) {
					lines.push(`- ${task.id}: ${task.description}`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { cancelledTasks: cancelled },
				};
			}

			if (params.taskId) {
				const task = manager.getTask(params.taskId);
				if (!task) {
					return {
						content: [{ type: "text", text: `Error: Task not found: ${params.taskId}` }],
						details: undefined,
						isError: true,
					};
				}

				const wasCancelled = manager.cancelTask(params.taskId);

				if (!wasCancelled) {
					return {
						content: [{ type: "text", text: `Task ${params.taskId} is not active (status: ${task.status})` }],
						details: { task },
					};
				}

				if (task.pid !== undefined) {
					try {
						process.kill(task.pid, "SIGTERM");
					} catch {
						/* process may already be dead */
					}
				}

				const cancelledTask = manager.getTask(params.taskId);
				if (!cancelledTask) {
					return {
						content: [{ type: "text", text: `Cancelled task ${params.taskId}` }],
						details: undefined,
					};
				}

				return {
					content: [{ type: "text", text: `Cancelled task ${params.taskId}: ${cancelledTask.description}` }],
					details: { task: cancelledTask },
				};
			}

			return {
				content: [{ type: "text", text: "Error: Provide taskId or set all=true" }],
				details: undefined,
				isError: true,
			};
		},
		renderCall(args, theme) {
			if (args.all) {
				return new Text(theme.fg("toolTitle", theme.bold("BackgroundCancel ")) + theme.fg("accent", "[all]"), 0, 0);
			}
			return new Text(
				theme.fg("toolTitle", theme.bold("BackgroundCancel ")) + theme.fg("accent", args.taskId ?? "unknown"),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const firstContent = result.content[0];
			const text = firstContent?.type === "text" ? firstContent.text : "(no output)";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	};
}
