import type { ExtensionAPI, ExtensionContext } from "../../types.js";
import { sendBuiltinCustomMessage } from "../system-messages.js";
import { createBackgroundCancelTool } from "./cancel-tool.js";
import { BackgroundManager, getWidgetLines } from "./manager.js";
import { sendCompletionNotification } from "./notification.js";
import { createBackgroundOutputTool } from "./output-tool.js";
import { spawnSubagent } from "./spawner.js";
import { createTaskTool } from "./task-tool.js";
import { type BackgroundTask, TASK_ENTRY_TYPE } from "./types.js";

type SessionEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
};

function isTaskStatus(value: unknown): value is BackgroundTask["status"] {
	return (
		value === "pending" || value === "running" || value === "completed" || value === "error" || value === "cancelled"
	);
}

function parseDate(value: unknown): Date | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : value;
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const parsedDate = new Date(value);
	return Number.isNaN(parsedDate.getTime()) ? undefined : parsedDate;
}

function parseBackgroundTask(value: unknown): BackgroundTask | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const taskRecord = value as Record<string, unknown>;
	const startedAt = parseDate(taskRecord.startedAt);
	const completedAt = parseDate(taskRecord.completedAt);

	if (
		typeof taskRecord.id !== "string" ||
		typeof taskRecord.description !== "string" ||
		typeof taskRecord.prompt !== "string" ||
		!isTaskStatus(taskRecord.status) ||
		(taskRecord.model !== undefined && typeof taskRecord.model !== "string") ||
		(taskRecord.agentType !== undefined && typeof taskRecord.agentType !== "string") ||
		(taskRecord.pid !== undefined && typeof taskRecord.pid !== "number") ||
		(taskRecord.sessionPath !== undefined && typeof taskRecord.sessionPath !== "string") ||
		(taskRecord.activeToolNames !== undefined &&
			(!Array.isArray(taskRecord.activeToolNames) ||
				taskRecord.activeToolNames.some((toolName) => typeof toolName !== "string"))) ||
		startedAt === undefined ||
		(taskRecord.completedAt !== undefined && completedAt === undefined) ||
		(taskRecord.result !== undefined && typeof taskRecord.result !== "string") ||
		(taskRecord.error !== undefined && typeof taskRecord.error !== "string") ||
		typeof taskRecord.parentSessionId !== "string"
	) {
		return undefined;
	}

	return {
		id: taskRecord.id,
		description: taskRecord.description,
		prompt: taskRecord.prompt,
		model: taskRecord.model,
		agentType: taskRecord.agentType,
		status: taskRecord.status,
		pid: taskRecord.pid,
		sessionPath: taskRecord.sessionPath,
		activeToolNames: Array.isArray(taskRecord.activeToolNames) ? taskRecord.activeToolNames : [],
		startedAt,
		completedAt,
		result: taskRecord.result,
		error: taskRecord.error,
		parentSessionId: taskRecord.parentSessionId,
	};
}

function isTerminalTask(task: BackgroundTask): boolean {
	return task.status === "completed" || task.status === "error" || task.status === "cancelled";
}

function getRestoredTasks(entries: SessionEntry[]): BackgroundTask[] {
	const restoredTasks = new Map<string, BackgroundTask>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TASK_ENTRY_TYPE) {
			continue;
		}

		const task = parseBackgroundTask(entry.data);
		if (!task) {
			continue;
		}

		if (isTerminalTask(task)) {
			restoredTasks.set(task.id, task);
		} else {
			restoredTasks.delete(task.id);
		}
	}

	return Array.from(restoredTasks.values());
}

function getCompletionTaskId(message: { content?: unknown }): string | undefined {
	if (!Array.isArray(message.content)) {
		return undefined;
	}

	for (const part of message.content) {
		if (typeof part !== "object" || part === null) {
			continue;
		}

		const contentPart = part as Record<string, unknown>;
		if (contentPart.type !== "text" || typeof contentPart.text !== "string") {
			continue;
		}

		const match = contentPart.text.match(/\b(bg_[0-9a-f]{8})\b/);
		if (match?.[1]) {
			return match[1];
		}
	}

	return undefined;
}

class ObservableBackgroundManager extends BackgroundManager {
	constructor(
		private readonly onChange: () => void,
		private readonly persistTask: (task: BackgroundTask) => void,
	) {
		super();
	}

	override launch(task: Omit<BackgroundTask, "id" | "status" | "startedAt">): BackgroundTask {
		const launchedTask = super.launch(task);
		this.onChange();
		return launchedTask;
	}

	override updateTask(id: string, updates: Partial<BackgroundTask>): void {
		super.updateTask(id, updates);
		this.onChange();
	}

	override cancelTask(id: string): boolean {
		const wasCancelled = super.cancelTask(id);
		if (wasCancelled) {
			const cancelledTask = this.getTask(id);
			if (cancelledTask) {
				this.persistTask(cancelledTask);
			}
			this.onChange();
		}
		return wasCancelled;
	}

	override cancelAll(): BackgroundTask[] {
		const cancelledTasks = super.cancelAll();
		for (const task of cancelledTasks) {
			this.persistTask(task);
		}
		if (cancelledTasks.length > 0) {
			this.onChange();
		}
		return cancelledTasks;
	}

	replaceTasks(tasks: BackgroundTask[]): void {
		this.clearTasks();
		for (const task of tasks) {
			this.restoreTask(task);
		}
		this.onChange();
	}
}

export default function backgroundTaskExtension(pi: ExtensionAPI): void {
	let currentContext: ExtensionContext | undefined;

	const syncWidget = (): void => {
		currentContext?.ui.setWidget("background-tasks", getWidgetLines(manager));
	};

	const manager = new ObservableBackgroundManager(
		() => {
			syncWidget();
		},
		(task) => {
			pi.appendEntry(TASK_ENTRY_TYPE, task);
		},
	);

	const syncFromSession = (ctx: ExtensionContext): void => {
		currentContext = ctx;
		manager.replaceTasks(getRestoredTasks(ctx.sessionManager.getBranch() as SessionEntry[]));
	};

	const notifyingPi = {
		...pi,
		sendMessage(message, options) {
			if (message.customType === "background-task.complete") {
				const taskId = getCompletionTaskId(message);
				if (taskId) {
					const task = manager.getTask(taskId);
					if (task && isTerminalTask(task)) {
						sendCompletionNotification(pi, task, manager);
						return;
					}
				}

				sendBuiltinCustomMessage(pi, "background-task.notification", message, options);
				return;
			}

			pi.sendMessage(message, options);
		},
	} satisfies ExtensionAPI;

	pi.on("session_start", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.registerTool(createTaskTool(manager, spawnSubagent, notifyingPi));
	pi.registerTool(createBackgroundOutputTool(manager));
	pi.registerTool(createBackgroundCancelTool(manager));

	process.on("exit", () => {
		for (const task of manager.getActiveTasks()) {
			if (task.pid === undefined) {
				continue;
			}

			try {
				process.kill(task.pid, "SIGTERM");
			} catch {}
		}
	});
}
