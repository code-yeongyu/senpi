import type { BackgroundTask } from "./types.js";
import { MAX_CONCURRENT_TASKS } from "./types.js";

export class BackgroundManager {
	private tasks: Map<string, BackgroundTask>;

	constructor() {
		this.tasks = new Map();
	}

	launch(task: Omit<BackgroundTask, "id" | "status" | "startedAt">): BackgroundTask {
		const activeTasks = this.getActiveTasks();
		if (activeTasks.length >= MAX_CONCURRENT_TASKS) {
			throw new Error(
				`Maximum concurrent tasks (${MAX_CONCURRENT_TASKS}) reached. Cancel some tasks before launching new ones.`,
			);
		}

		const newTask: BackgroundTask = {
			...task,
			id: generateTaskId(),
			status: "pending",
			startedAt: new Date(),
		};

		this.tasks.set(newTask.id, newTask);
		return newTask;
	}

	getTask(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	getAllTasks(): BackgroundTask[] {
		return Array.from(this.tasks.values());
	}

	getActiveTasks(): BackgroundTask[] {
		return this.getAllTasks().filter((task) => task.status === "pending" || task.status === "running");
	}

	updateTask(id: string, updates: Partial<BackgroundTask>): void {
		const task = this.tasks.get(id);
		if (!task) {
			throw new Error(`Task ${id} not found`);
		}

		const updatedTask = { ...task, ...updates };
		this.tasks.set(id, updatedTask);
	}

	cancelTask(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task) {
			return false;
		}

		if (task.status === "pending" || task.status === "running") {
			this.tasks.set(id, { ...task, status: "cancelled" });
			return true;
		}

		return false;
	}

	cancelAll(): BackgroundTask[] {
		const cancelled: BackgroundTask[] = [];

		for (const task of this.tasks.values()) {
			if (task.status === "pending" || task.status === "running") {
				this.tasks.set(task.id, { ...task, status: "cancelled" });
				cancelled.push(this.tasks.get(task.id)!);
			}
		}

		return cancelled;
	}

	getTasksByParent(parentSessionId: string): BackgroundTask[] {
		return this.getAllTasks().filter((task) => task.parentSessionId === parentSessionId);
	}

	restoreTask(task: BackgroundTask): void {
		this.tasks.set(task.id, task);
	}

	clearTasks(): void {
		this.tasks.clear();
	}
}

export function getWidgetLines(manager: BackgroundManager): string[] | undefined {
	const activeTasks = manager.getActiveTasks();

	if (activeTasks.length === 0) {
		return undefined;
	}

	const taskLines = activeTasks.map((task) => {
		const indicator = task.status === "pending" ? "[⏳]" : "[▶]";
		return `${indicator} ${task.description}`;
	});

	return ["Background Tasks", ...taskLines];
}

function generateTaskId(): string {
	return (
		"bg_" +
		Math.floor(Math.random() * 0xffffffff)
			.toString(16)
			.padStart(8, "0")
	);
}
