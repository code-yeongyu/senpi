import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../types.js";
import type { BackgroundManager } from "./manager.js";
import type { spawnSubagent } from "./spawner.js";
import { DEPTH_ENV_VAR, MAX_SUBAGENT_DEPTH, TASK_ENTRY_TYPE } from "./types.js";

type TaskToolDetails = {
	agentType?: string;
	model?: string;
	activeToolNames?: string[];
};

function buildTaskMetadata(args: {
	description: string;
	runInBackground: boolean;
	agentType?: string;
	model?: string;
	activeToolNames?: string[];
}): { headline: string; overview?: string } {
	const overview = [
		args.agentType,
		args.model,
		args.activeToolNames && args.activeToolNames.length > 0 ? `tools: ${args.activeToolNames.join(", ")}` : undefined,
	].filter((value): value is string => typeof value === "string" && value.length > 0);

	return {
		headline: `${args.description}${args.runInBackground ? " [async]" : " [sync]"}`,
		...(overview.length > 0 ? { overview: overview.join(" · ") } : {}),
	};
}

function buildTaskOverviewItems(details: TaskToolDetails | undefined): string[] {
	if (!details) {
		return [];
	}

	return [
		details.agentType,
		details.model,
		details.activeToolNames && details.activeToolNames.length > 0
			? `tools: ${details.activeToolNames.join(", ")}`
			: undefined,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
}

const TaskToolParams = Type.Object({
	description: Type.String({
		description: "A short (3-5 words) description of the task",
	}),
	prompt: Type.String({
		description: "The task for the agent to perform",
	}),
	run_in_background: Type.Boolean({
		description:
			"REQUIRED. true=async (returns task_id, system notifies on completion), false=sync (waits for result).",
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
	details: TaskToolDetails;
	isError: true;
} {
	return {
		content: [{ type: "text", text }],
		details: {},
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
): ToolDefinition<typeof TaskToolParams, TaskToolDetails> {
	const baseDescription = `Run a sub-agent in sync or async mode.

Sync mode (run_in_background=false): waits for the sub-agent to finish and returns its text output directly.
Async mode (run_in_background=true): starts the sub-agent, returns a task_id immediately. System sends a notification when done.

session_id is optional and continues an existing session when provided.
model is optional and defaults to the current model.`;

	const fullDescription = agentDescriptions
		? `${baseDescription}\n\nAvailable agent types:\n${agentDescriptions}`
		: baseDescription;

	const taskTool: ToolDefinition<typeof TaskToolParams, TaskToolDetails> = {
		name: "task",
		label: "Task",
		description: fullDescription,
		promptSnippet:
			"Run a sub-agent either synchronously for direct output or asynchronously for a background task_id.",
		promptGuidelines: [
			"Use run_in_background=false when you need the sub-agent result in the same turn.",
			"Use run_in_background=true for parallel work. System notifies on completion via <system-reminder>.",
			"After launching a background task, do NOT call background_output - wait for the <system-reminder> notification first.",
			"Pass session_id to continue an existing sub-agent session.",
		],
		parameters: TaskToolParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.description.trim()) {
				return createErrorResult("Error: description is required");
			}

			const currentDepth = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
			if (currentDepth >= MAX_SUBAGENT_DEPTH) {
				return createErrorResult(`Error: max subagent depth (${MAX_SUBAGENT_DEPTH}) exceeded`);
			}

			const model = resolveModel(params, ctx);
			const taskDetails: TaskToolDetails = {
				agentType: params.agent_type,
				model,
				activeToolNames: [],
			};

			const permissionFlag =
				typeof pi.getFlag === "function"
					? ((pi.getFlag("permission") as string | undefined) ?? undefined)
					: undefined;

			if (!params.run_in_background) {
				const spawned = spawner({
					prompt: params.prompt,
					cwd: ctx.cwd,
					model,
					agentType: params.agent_type,
					sessionPath: params.session_id,
					permissionFlag: permissionFlag ?? undefined,
					signal,
				});
				const result = await spawned.result;

				return {
					content: [{ type: "text", text: result.text || "(no output)" }],
					details: taskDetails,
				};
			}

			let executeReturned = false;
			try {
				const task = manager.launch({
					description: params.description,
					prompt: params.prompt,
					model,
					agentType: params.agent_type,
					pid: undefined,
					sessionPath: params.session_id,
					activeToolNames: [],
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
					permissionFlag: permissionFlag ?? undefined,
					signal,
					onEvent: (() => {
						const activeToolCalls = new Map<string, string>();
						return (event) => {
							if (event.type === "tool_execution_start") {
								activeToolCalls.set(event.toolCallId, event.toolName);
							} else if (event.type === "tool_execution_end") {
								activeToolCalls.delete(event.toolCallId);
							}

							const currentTask = manager.getTask(task.id);
							if (!currentTask) {
								return;
							}

							const activeToolNames = Array.from(activeToolCalls.values());

							manager.updateTask(task.id, {
								activeToolNames,
								...(activeToolCalls.size > 0 && currentTask.status === "pending" ? { status: "running" } : {}),
							});
							if (!executeReturned) {
								onUpdate?.({
									content: [],
									details: {
										...taskDetails,
										activeToolNames,
									},
								});
							}
							const activeTask = manager.getTask(task.id);
							if (activeTask) {
								pi.appendEntry(TASK_ENTRY_TYPE, activeTask);
							}
						};
					})(),
				});

				if (spawned.process.pid !== undefined) {
					manager.updateTask(task.id, { pid: spawned.process.pid, status: "running" });
					onUpdate?.({ content: [], details: taskDetails });
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
							activeToolNames: [],
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
										text: [
											`Task ${task.id} completed: ${params.description}`,
											"",
											"Result:",
											result.text || "(no output)",
										].join("\n"),
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
							activeToolNames: [],
							error: error instanceof Error ? error.message : String(error),
						});

						const erroredTask = manager.getTask(task.id);
						if (erroredTask) {
							pi.appendEntry(TASK_ENTRY_TYPE, erroredTask);
						}

						const errorMsg = error instanceof Error ? error.message : String(error);
						pi.sendMessage(
							{
								customType: "background-task.complete",
								display: true,
								content: [
									{
										type: "text",
										text: [`Task ${task.id} failed: ${params.description}`, "", "Error:", errorMsg].join(
											"\n",
										),
									},
								],
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					});

				executeReturned = true;

				const sessionIdBlock = params.session_id
					? `\n\n<task_metadata>\nsession_id: ${params.session_id}\ntask_id: ${task.id}\nbackground_task_id: ${task.id}\n</task_metadata>\n\nto continue: task(session_id="${params.session_id}", run_in_background=false, prompt="...")`
					: `\n\n<task_metadata>\ntask_id: ${task.id}\nbackground_task_id: ${task.id}\n</task_metadata>`;

				return {
					content: [
						{
							type: "text",
							text: `Background task launched.

Background Task ID: ${task.id}
Description: ${params.description}
Agent: ${params.agent_type ?? "default"}
Status: ${task.status}

System notifies on completion. Use \`background_output\` with task_id="${task.id}" to check.

Do NOT call background_output now. Wait for <system-reminder> notification first.${sessionIdBlock}`,
						},
					],
					details: taskDetails,
				};
			} catch (error: unknown) {
				return createErrorResult(error instanceof Error ? error.message : String(error));
			}
		},
		renderCall(args, theme) {
			const metadata = buildTaskMetadata({
				description: args.description,
				runInBackground: args.run_in_background,
				agentType: args.agent_type,
				model: args.model,
			});
			return new Text(
				[
					theme.fg("toolTitle", theme.bold("Task ")) + theme.fg("accent", metadata.headline),
					...(metadata.overview ? [theme.fg("muted", `  ${metadata.overview}`)] : []),
				].join("\n"),
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			const firstContent = result.content[0];
			const text = firstContent?.type === "text" ? firstContent.text : undefined;
			const argDetails: TaskToolDetails = {
				agentType: context.args.agent_type,
				model: context.args.model,
			};
			const callOverviewItems = new Set(buildTaskOverviewItems(argDetails));
			const extraOverviewItems = buildTaskOverviewItems(result.details).filter(
				(item) => !callOverviewItems.has(item),
			);
			const overview = extraOverviewItems.length > 0 ? extraOverviewItems.join(" · ") : undefined;

			if (!text && !overview) {
				return new Text("", 0, 0);
			}

			if (options.isPartial && !text) {
				return new Text(overview ? theme.fg("muted", overview) : "", 0, 0);
			}

			return new Text(
				[...(overview ? [theme.fg("muted", overview)] : []), ...(text ? [theme.fg("muted", text)] : [])].join(
					"\n\n",
				),
				0,
				0,
			);
		},
	};

	return taskTool;
}
