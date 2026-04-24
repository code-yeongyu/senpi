import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "../../types.js";
import type { BackgroundManager } from "./manager.js";
import type { BackgroundTask } from "./types.js";
import { DEFAULT_BLOCK_TIMEOUT, MAX_BLOCK_TIMEOUT } from "./types.js";

const BackgroundOutputParams = Type.Object({
	task_id: Type.String({ description: "Task ID to get output from" }),
	block: Type.Optional(
		Type.Boolean({
			description: "Wait for completion (default: false). System notifies when done, so blocking is rarely needed.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Max wait time in ms (default: 60000, max: 300000)" })),
});

function formatDuration(startedAt: Date, completedAt: Date | undefined): string {
	const end = completedAt ?? new Date();
	const ms = end.getTime() - startedAt.getTime();
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function formatTaskOutput(task: BackgroundTask): string {
	const lines: string[] = [`Task: ${task.id}`, `Description: ${task.description}`, `Status: ${task.status}`];

	if (task.status === "completed") {
		lines.push(`Duration: ${formatDuration(task.startedAt, task.completedAt)}`);
		lines.push("Result:");
		lines.push(task.result ?? "(no output)");
	} else if (task.status === "error") {
		lines.push(`Duration: ${formatDuration(task.startedAt, task.completedAt)}`);
		lines.push("Error:");
		lines.push(task.error ?? "(unknown error)");
	} else if (task.status === "cancelled") {
		lines.push(`Duration: ${formatDuration(task.startedAt, task.completedAt)}`);
		lines.push("Status: Cancelled");
	} else {
		lines.push(`Elapsed: ${formatDuration(task.startedAt, undefined)}`);
	}

	return lines.join("\n");
}

export function createBackgroundOutputTool(manager: BackgroundManager): ToolDefinition<typeof BackgroundOutputParams> {
	return {
		name: "background_output",
		label: "BackgroundOutput",
		description: `Get output from background task. System notifies on completion, so block=true rarely needed.

IMPORTANT: ONLY call this tool AFTER receiving a <system-reminder> notification for the task. Do NOT call immediately after launching a background task - wait for the notification first.`,
		promptSnippet: "Retrieve results from a completed background task by task_id.",
		promptGuidelines: [
			"ONLY call this tool AFTER receiving a <system-reminder> notification for the task.",
			"Do NOT call this immediately after launching a background task - wait for the notification first.",
			"Set block=true only if you must wait synchronously (rarely needed).",
		],
		parameters: BackgroundOutputParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = manager.getTask(params.task_id);

			if (!task) {
				return {
					content: [{ type: "text", text: `Error: Task not found: ${params.task_id}` }],
					details: undefined,
					isError: true,
				};
			}

			if (task.status === "completed" || task.status === "error" || task.status === "cancelled") {
				return {
					content: [{ type: "text", text: formatTaskOutput(task) }],
					details: { task },
				};
			}

			if (!params.block) {
				return {
					content: [
						{
							type: "text",
							text: `Task ${params.task_id} is still running. Do NOT call BackgroundOutput again for this task - the system will notify you when it completes. Continue with other work or end your response.`,
						},
					],
					details: { task },
				};
			}

			const timeoutMs = Math.min(params.timeout ?? DEFAULT_BLOCK_TIMEOUT, MAX_BLOCK_TIMEOUT);
			const startTime = Date.now();

			try {
				const finalTask = await new Promise<BackgroundTask>((resolve, reject) => {
					const interval = setInterval(() => {
						const current = manager.getTask(params.task_id);
						if (!current) {
							clearInterval(interval);
							reject(new Error(`Task not found: ${params.task_id}`));
							return;
						}
						if (current.status === "completed" || current.status === "error" || current.status === "cancelled") {
							clearInterval(interval);
							resolve(current);
							return;
						}
						if (Date.now() - startTime >= timeoutMs) {
							clearInterval(interval);
							reject(new Error(`Timeout waiting for task ${params.task_id}`));
						}
					}, 100);
				});

				return {
					content: [{ type: "text", text: formatTaskOutput(finalTask) }],
					details: { task: finalTask },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("BackgroundOutput ")) + theme.fg("accent", args.task_id),
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
