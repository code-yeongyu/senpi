import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../types.js";
import type { BackgroundManager } from "./manager.js";
import type { spawnSubagent } from "./spawner.js";
import { DEPTH_ENV_VAR, MAX_SUBAGENT_DEPTH, TASK_ENTRY_TYPE } from "./types.js";

const TaskToolParams = Type.Object({
	description: Type.String({
		description: "A short (3-5 words) description of the task",
	}),
	prompt: Type.String({
		description: "The task for the agent to perform",
	}),
	run_in_background: Type.Boolean({
		description:
			"REQUIRED. true: run asynchronously (use BackgroundOutput to get results), false: run synchronously and wait for completion",
	}),
	session_id: Type.Optional(Type.String({ description: "Existing Task session to continue" })),
	model: Type.Optional(Type.String({ description: "Model to use for this task" })),
	agent_type: Type.Optional(
		Type.String({
			description:
				"Agent type to use for this task (e.g. 'explore', 'general'). Determines available tools and permissions.",
		}),
	),
});

function createErrorResult(text: string): {
	content: [{ type: "text"; text: string }];
	details: undefined;
	isError: true;
} {
	return {
		content: [{ type: "text", text }],
		details: undefined,
		isError: true,
	};
}

function resolveModel(params: { model?: string }, ctx: ExtensionContext): string | undefined {
	if (params.model) {
		return params.model;
	}

	if (!ctx.model) {
		return undefined;
	}

	return `${ctx.model.provider}/${ctx.model.id}`;
}

function isCancelledTask(manager: BackgroundManager, taskId: string): boolean {
	return manager.getTask(taskId)?.status === "cancelled";
}

export function createTaskTool(
	manager: BackgroundManager,
	spawner: typeof spawnSubagent,
	pi: ExtensionAPI,
	agentDescriptions?: string,
): ToolDefinition<typeof TaskToolParams> {
	const baseDescription = `Run a sub-agent in sync or async mode.

Sync mode (run_in_background=false): waits for the sub-agent to finish and returns its text output directly.
Async mode (run_in_background=true): starts the sub-agent, returns a task_id immediately, and use BackgroundOutput to retrieve results later.

session_id is optional and continues an existing session when provided.
model is optional and defaults to the current model.`;

	const fullDescription = agentDescriptions
		? `${baseDescription}\n\nAvailable agent types:\n${agentDescriptions}`
		: baseDescription;

	const taskTool: ToolDefinition<typeof TaskToolParams> = {
		name: "task",
		label: "Task",
		description: fullDescription,
		promptSnippet:
			"Run a sub-agent either synchronously for direct output or asynchronously for a background task_id.",
		promptGuidelines: [
			"Use run_in_background=false when you need the sub-agent result in the same turn.",
			"Use run_in_background=true when work can continue later and retrieve output via BackgroundOutput.",
			"Pass session_id to continue an existing sub-agent session.",
		],
		parameters: TaskToolParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.description.trim()) {
				return createErrorResult("Error: description is required");
			}

			const currentDepth = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
			if (currentDepth >= MAX_SUBAGENT_DEPTH) {
				return createErrorResult(`Error: max subagent depth (${MAX_SUBAGENT_DEPTH}) exceeded`);
			}

			const model = resolveModel(params, ctx);

			if (!params.run_in_background) {
				const spawned = spawner({
					prompt: params.prompt,
					cwd: ctx.cwd,
					model,
					agentType: params.agent_type,
					sessionPath: params.session_id,
					signal,
				});
				const result = await spawned.result;

				return {
					content: [{ type: "text", text: result.text || "(no output)" }],
					details: undefined,
				};
			}

			try {
				const task = manager.launch({
					description: params.description,
					prompt: params.prompt,
					model,
					pid: undefined,
					sessionPath: params.session_id,
					completedAt: undefined,
					result: undefined,
					error: undefined,
					parentSessionId: "unknown",
				});

				pi.appendEntry(TASK_ENTRY_TYPE, task);

				const spawned = spawner({
					prompt: params.prompt,
					cwd: ctx.cwd,
					model,
					agentType: params.agent_type,
					sessionPath: params.session_id,
					signal,
				});

				if (spawned.process.pid !== undefined) {
					manager.updateTask(task.id, { pid: spawned.process.pid, status: "running" });
					const runningTask = manager.getTask(task.id);
					if (runningTask) {
						pi.appendEntry(TASK_ENTRY_TYPE, runningTask);
					}
				}

				spawned.result
					.then((result) => {
						if (isCancelledTask(manager, task.id)) {
							return;
						}

						manager.updateTask(task.id, {
							status: result.exitCode === 0 ? "completed" : "error",
							completedAt: new Date(),
							result: result.text,
							error: result.exitCode === 0 ? undefined : `Sub-agent exited with code ${result.exitCode}`,
						});

						const completedTask = manager.getTask(task.id);
						if (completedTask) {
							pi.appendEntry(TASK_ENTRY_TYPE, completedTask);
						}

						pi.sendMessage(
							{
								customType: "background-task.complete",
								display: true,
								content: [
									{
										type: "text",
										text: `Task ${task.id} completed: ${params.description}`,
									},
								],
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					})
					.catch((error: unknown) => {
						if (isCancelledTask(manager, task.id)) {
							return;
						}

						manager.updateTask(task.id, {
							status: "error",
							completedAt: new Date(),
							error: error instanceof Error ? error.message : String(error),
						});

						const erroredTask = manager.getTask(task.id);
						if (erroredTask) {
							pi.appendEntry(TASK_ENTRY_TYPE, erroredTask);
						}

						pi.sendMessage(
							{
								customType: "background-task.complete",
								display: true,
								content: [
									{
										type: "text",
										text: `Task ${task.id} failed: ${params.description}`,
									},
								],
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					});

				return {
					content: [
						{
							type: "text",
							text: `Task started: ${task.id}\nDescription: ${params.description}\nUse BackgroundOutput to retrieve results.`,
						},
					],
					details: undefined,
				};
			} catch (error: unknown) {
				return createErrorResult(error instanceof Error ? error.message : String(error));
			}
		},
		renderCall(args, theme) {
			const mode = args.run_in_background ? "async" : "sync";
			return new Text(
				theme.fg("toolTitle", theme.bold("Task ")) +
					theme.fg("accent", args.description) +
					theme.fg("muted", ` [${mode}]`),
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

	return taskTool;
}
