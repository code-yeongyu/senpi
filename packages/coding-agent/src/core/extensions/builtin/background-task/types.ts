import { type Static, Type } from "typebox";

export type SpawnOptions = {
	prompt: string;
	cwd: string;
	model?: string;
	agentType?: string;
	sessionPath?: string;
	permissionFlag?: string;
	signal?: AbortSignal;
	env?: Record<string, string>;
	onEvent?: (event: SpawnEvent) => void;
};

export type SpawnEvent =
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
	  };

export type SpawnedAgent = {
	process: import("node:child_process").ChildProcess;
	result: Promise<{ text: string; exitCode: number }>;
};

export type BackgroundTask = {
	id: string;
	description: string;
	prompt: string;
	model: string | undefined;
	agentType: string | undefined;
	status: "pending" | "running" | "completed" | "error" | "cancelled";
	pid: number | undefined;
	sessionPath: string | undefined;
	activeToolNames: string[];
	startedAt: Date;
	completedAt: Date | undefined;
	result: string | undefined;
	error: string | undefined;
	parentSessionId: string;
};

export const TaskToolParams = Type.Object({
	description: Type.String({ description: "A short (3-5 words) description of the task" }),
	prompt: Type.String({ description: "The task for the agent to perform" }),
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

export type TaskToolParamsType = Static<typeof TaskToolParams>;

export const BackgroundOutputParams = Type.Object({
	task_id: Type.String({ description: "Task ID to get output from" }),
	block: Type.Optional(
		Type.Boolean({
			description: "Wait for completion (default: false). System notifies when done, so blocking is rarely needed.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Max wait time in ms (default: 60000, max: 300000)" })),
});

export type BackgroundOutputParamsType = Static<typeof BackgroundOutputParams>;

export const BackgroundCancelParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "Task ID to cancel (required if all=false)" })),
	all: Type.Optional(Type.Boolean({ description: "Cancel all running background tasks (default: false)" })),
});

export type BackgroundCancelParamsType = Static<typeof BackgroundCancelParams>;

export const MAX_CONCURRENT_TASKS = Infinity;
export const MAX_SUBAGENT_DEPTH = 1;
export const DEPTH_ENV_VAR = "SANEPI_SUBAGENT_DEPTH";
export const AGENT_TYPE_ENV_VAR = "SANEPI_AGENT_TYPE";
export const TASK_ENTRY_TYPE = "background-task.state";
export const DEFAULT_BLOCK_TIMEOUT = 60000;
export const MAX_BLOCK_TIMEOUT = 300000;
