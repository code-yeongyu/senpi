import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundTaskExtension from "../../src/core/extensions/builtin/background-task/index.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createBackgroundCancelTool } from "../../src/core/extensions/builtin/background-task/cancel-tool.js";
import { BackgroundManager, getWidgetLines } from "../../src/core/extensions/builtin/background-task/manager.js";
import { createBackgroundOutputTool } from "../../src/core/extensions/builtin/background-task/output-tool.js";
import { createTaskTool } from "../../src/core/extensions/builtin/background-task/task-tool.js";
import type { BackgroundTask } from "../../src/core/extensions/builtin/background-task/types.js";
import {
	DEPTH_ENV_VAR,
	MAX_CONCURRENT_TASKS,
	MAX_SUBAGENT_DEPTH,
} from "../../src/core/extensions/builtin/background-task/types.js";

const mockSpawn = spawn as ReturnType<typeof vi.fn>;

function createMockProcess(options: { stdout: string; exitCode?: number }) {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		killed: boolean;
		kill: (signal?: string) => boolean;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 12345;
	proc.killed = false;
	proc.kill = () => {
		proc.killed = true;
		return true;
	};

	setTimeout(() => {
		const ndjson = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: options.stdout }],
			},
		});
		proc.stdout.emit("data", Buffer.from(`${ndjson}\n`));
		proc.emit("close", options.exitCode ?? 0);
	}, 10);

	return proc;
}

async function createHarnessWithBgExtension(): Promise<Harness> {
	const extensionsResult = await createTestExtensionsResult([backgroundTaskExtension], "/tmp");
	return createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
}

function getLatestToolResult(harness: Harness, toolName: string) {
	const results = harness.session.messages.filter(
		(message) => message.role === "toolResult" && message.toolName === toolName,
	);
	const latest = results[results.length - 1];
	if (!latest || latest.role !== "toolResult") {
		throw new Error(`Expected a ${toolName} tool result`);
	}
	return latest;
}

describe("background-task extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		mockSpawn.mockClear();
		vi.unstubAllEnvs();
	});

	describe("BackgroundManager", () => {
		it("launch creates task with bg_ prefix ID format", () => {
			const manager = new BackgroundManager();

			const task = manager.launch({
				description: "Test task",
				prompt: "Do something",
				model: undefined,
				pid: undefined,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});

			expect(task.id).toMatch(/^bg_[0-9a-f]{8}$/);
			expect(task.status).toBe("pending");
			expect(task.description).toBe("Test task");
		});

		it("max concurrent tasks enforced (8 limit)", () => {
			const manager = new BackgroundManager();

			for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
				manager.launch({
					description: `Task ${i}`,
					prompt: `Do ${i}`,
					model: undefined,
					pid: undefined,
					sessionPath: undefined,
					completedAt: undefined,
					result: undefined,
					error: undefined,
					parentSessionId: "test-session",
				});
			}

			expect(() => {
				manager.launch({
					description: "Overflow task",
					prompt: "Do overflow",
					model: undefined,
					pid: undefined,
					sessionPath: undefined,
					completedAt: undefined,
					result: undefined,
					error: undefined,
					parentSessionId: "test-session",
				});
			}).toThrow(`Maximum concurrent tasks (${MAX_CONCURRENT_TASKS}) reached`);
		});

		it("cancel sets status and returns correct boolean", () => {
			const manager = new BackgroundManager();
			const task = manager.launch({
				description: "Test task",
				prompt: "Do something",
				model: undefined,
				pid: undefined,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});

			const cancelled = manager.cancelTask(task.id);

			expect(cancelled).toBe(true);
			expect(manager.getTask(task.id)?.status).toBe("cancelled");

			const secondCancel = manager.cancelTask(task.id);

			expect(secondCancel).toBe(false);
		});

		it("cancel returns false for non-existent task", () => {
			const manager = new BackgroundManager();

			const result = manager.cancelTask("bg_nonexistent");

			expect(result).toBe(false);
		});

		it("getWidgetLines returns undefined when no active tasks", () => {
			const manager = new BackgroundManager();

			const lines = getWidgetLines(manager);

			expect(lines).toBeUndefined();
		});

		it("getWidgetLines shows active tasks", () => {
			const manager = new BackgroundManager();
			manager.launch({
				description: "Pending task",
				prompt: "Do pending",
				model: undefined,
				pid: undefined,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});
			const runningTask = manager.launch({
				description: "Running task",
				prompt: "Do running",
				model: undefined,
				pid: undefined,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});
			manager.updateTask(runningTask.id, { status: "running" });

			const lines = getWidgetLines(manager);

			expect(lines).toEqual(["Background Tasks", "[⏳] Pending task", "[▶] Running task"]);
		});

		it("widget shows active tasks and hides when empty", () => {
			// given
			const manager = new BackgroundManager();

			// when - no tasks
			const emptyLines = getWidgetLines(manager);

			// then
			expect(emptyLines).toBeUndefined();

			// when - add active task
			manager.launch({
				description: "active task",
				prompt: "test",
				model: undefined,
				pid: undefined,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});
			const activeLines = getWidgetLines(manager);

			// then
			expect(activeLines).toBeDefined();
			expect(activeLines?.[0]).toBe("Background Tasks");
			expect(activeLines?.[1]).toContain("active task");
		});
	});

	describe("Task tool", () => {
		it("sync mode spawns sub-agent, waits, returns result text", async () => {
			const manager = new BackgroundManager();
			const mockPi = {
				appendEntry: vi.fn(),
				on: vi.fn(),
				registerTool: vi.fn(),
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerFlag: vi.fn(),
				registerProvider: vi.fn(),
				registerMessageRenderer: vi.fn(),
				ui: { setFooter: vi.fn(), setWidget: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
				sendMessage: vi.fn(),
			};

			mockSpawn.mockReturnValue(createMockProcess({ stdout: "Sub-agent result", exitCode: 0 }));

			const tool = createTaskTool(
				manager,
				(await import("../../src/core/extensions/builtin/background-task/spawner.js")).spawnSubagent,
				mockPi as unknown as Parameters<typeof createTaskTool>[2],
			);

			const mockCtx = {
				cwd: "/tmp",
				model: undefined,
				signal: undefined,
				ui: { setWidget: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
				sessionManager: { getBranch: () => [] },
				hasUI: false,
				isIdle: () => true,
				hasPendingMessages: () => false,
				abort: () => {},
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
			};

			const result = await tool.execute(
				"call-1",
				{ description: "Test", prompt: "Do it", run_in_background: false },
				undefined,
				vi.fn(),
				mockCtx as unknown as Parameters<typeof tool.execute>[4],
			);

			expect(mockSpawn).toHaveBeenCalled();
			expect(result.content[0]).toEqual({ type: "text", text: "Sub-agent result" });
		});

		it("async mode returns task_id immediately (bg_ format)", async () => {
			const harness = await createHarnessWithBgExtension();
			harnesses.push(harness);

			mockSpawn.mockReturnValue(createMockProcess({ stdout: "Async result", exitCode: 0 }));

			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task", { description: "Async task", prompt: "Do async", run_in_background: true })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("start async task");

			const result = getLatestToolResult(harness, "task");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Task started: bg_[0-9a-f]{8}/);
			expect(text).toContain("Description: Async task");
		});

		it("keeps async task cancelled when the sub-agent completes later", async () => {
			// given
			const manager = new BackgroundManager();
			const mockPi = {
				appendEntry: vi.fn(),
				on: vi.fn(),
				registerTool: vi.fn(),
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				registerFlag: vi.fn(),
				registerProvider: vi.fn(),
				registerMessageRenderer: vi.fn(),
				ui: { setFooter: vi.fn(), setWidget: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
				sendMessage: vi.fn(),
			};
			const mockCtx = {
				cwd: "/tmp",
				model: undefined,
				signal: undefined,
				ui: { setWidget: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
				sessionManager: { getBranch: () => [] },
				hasUI: false,
				isIdle: () => true,
				hasPendingMessages: () => false,
				abort: () => {},
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
			};
			let resolveResult: ((value: { text: string; exitCode: number }) => void) | undefined;
			const mockSpawner = vi.fn(() => ({
				process: { pid: 12345 },
				result: new Promise<{ text: string; exitCode: number }>((resolve) => {
					resolveResult = resolve;
				}),
			}));

			const tool = createTaskTool(
				manager,
				mockSpawner as unknown as Parameters<typeof createTaskTool>[1],
				mockPi as unknown as Parameters<typeof createTaskTool>[2],
			);

			await tool.execute(
				"call-1",
				{ description: "Async task", prompt: "Do async", run_in_background: true },
				undefined,
				vi.fn(),
				mockCtx as unknown as Parameters<typeof tool.execute>[4],
			);

			const [task] = manager.getAllTasks();
			if (!task) {
				throw new Error("Expected task to be launched");
			}
			manager.cancelTask(task.id);

			// when
			resolveResult?.({ text: "late result", exitCode: 0 });
			await Promise.resolve();
			await Promise.resolve();

			// then
			expect(manager.getTask(task.id)?.status).toBe("cancelled");
			expect(mockPi.sendMessage).not.toHaveBeenCalled();
		});

		it("depth limit blocks execution at MAX_SUBAGENT_DEPTH", async () => {
			vi.stubEnv(DEPTH_ENV_VAR, String(MAX_SUBAGENT_DEPTH));

			const harness = await createHarnessWithBgExtension();
			harnesses.push(harness);

			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task", { description: "Deep task", prompt: "Do deep", run_in_background: false })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("try deep task");

			const result = getLatestToolResult(harness, "task");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain(`max subagent depth (${MAX_SUBAGENT_DEPTH}) exceeded`);
		});
	});

	describe("BackgroundOutput tool", () => {
		it("returns completed task result", async () => {
			const manager = new BackgroundManager();
			const task = manager.launch({
				description: "Completed task",
				prompt: "Do it",
				model: undefined,
				pid: 12345,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});

			// Mark as completed
			manager.updateTask(task.id, {
				status: "completed",
				completedAt: new Date(),
				result: "Task completed successfully",
			});

			const tool = createBackgroundOutputTool(manager);

			const result = await tool.execute(
				"call-1",
				{ task_id: task.id },
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain(`Task: ${task.id}`);
			expect(text).toContain("Status: completed");
			expect(text).toContain("Task completed successfully");
		});

		it("returns running task status when not blocking", async () => {
			const manager = new BackgroundManager();
			const task = manager.launch({
				description: "Running task",
				prompt: "Do it",
				model: undefined,
				pid: 12345,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});
			manager.updateTask(task.id, { status: "running" });

			const tool = createBackgroundOutputTool(manager);

			const result = await tool.execute(
				"call-1",
				{ task_id: task.id, block: false },
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Status: running");
			expect(text).toContain("Elapsed:");
		});

		it("returns error for non-existent task", async () => {
			const manager = new BackgroundManager();
			const tool = createBackgroundOutputTool(manager);

			const result = await tool.execute(
				"call-1",
				{ task_id: "bg_nonexistent" },
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			expect((result as unknown as { isError: boolean }).isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Task not found");
		});

		it("blocks until task completes when block=true", async () => {
			// given
			const manager = new BackgroundManager();
			const outputTool = createBackgroundOutputTool(manager);
			const task = manager.launch({
				description: "blocking test",
				prompt: "test",
				model: undefined,
				pid: undefined,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test",
			});
			manager.updateTask(task.id, { status: "running" });

			// Complete the task after 50ms
			setTimeout(() => {
				manager.updateTask(task.id, {
					status: "completed",
					completedAt: new Date(),
					result: "blocking result",
				});
			}, 50);

			// when
			const result = await outputTool.execute(
				"id",
				{ task_id: task.id, block: true, timeout: 5000 },
				undefined,
				() => {},
				{} as unknown as Parameters<typeof outputTool.execute>[4],
			);

			// then
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("completed");
			expect(text).toContain("blocking result");
		});
	});

	describe("BackgroundCancel tool", () => {
		it("cancels running task", async () => {
			const manager = new BackgroundManager();
			const task = manager.launch({
				description: "Running task",
				prompt: "Do it",
				model: undefined,
				pid: 12345,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});
			manager.updateTask(task.id, { status: "running" });

			const tool = createBackgroundCancelTool(manager);

			const result = await tool.execute(
				"call-1",
				{ taskId: task.id },
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain(`Cancelled task ${task.id}`);
			expect(manager.getTask(task.id)?.status).toBe("cancelled");
		});

		it("cancels all tasks", async () => {
			const manager = new BackgroundManager();
			const task1 = manager.launch({
				description: "Task 1",
				prompt: "Do 1",
				model: undefined,
				pid: 12345,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});
			const task2 = manager.launch({
				description: "Task 2",
				prompt: "Do 2",
				model: undefined,
				pid: 12346,
				sessionPath: undefined,
				completedAt: undefined,
				result: undefined,
				error: undefined,
				parentSessionId: "test-session",
			});
			manager.updateTask(task1.id, { status: "running" });
			manager.updateTask(task2.id, { status: "running" });

			const tool = createBackgroundCancelTool(manager);

			const result = await tool.execute(
				"call-1",
				{ all: true },
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Cancelled 2 task(s)");
			expect(manager.getTask(task1.id)?.status).toBe("cancelled");
			expect(manager.getTask(task2.id)?.status).toBe("cancelled");
		});

		it("returns error when no taskId or all flag provided", async () => {
			const manager = new BackgroundManager();
			const tool = createBackgroundCancelTool(manager);

			const result = await tool.execute(
				"call-1",
				{},
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			expect((result as unknown as { isError: boolean }).isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Provide taskId or set all=true");
		});

		it("returns message when cancelling non-active task", async () => {
			const manager = new BackgroundManager();
			const task = manager.launch({
				description: "Completed task",
				prompt: "Do it",
				model: undefined,
				pid: undefined,
				sessionPath: undefined,
				completedAt: undefined,
				result: "Done",
				error: undefined,
				parentSessionId: "test-session",
			});
			manager.updateTask(task.id, { status: "completed" });

			const tool = createBackgroundCancelTool(manager);

			const result = await tool.execute(
				"call-1",
				{ taskId: task.id },
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("is not active");
			expect(text).toContain("completed");
		});

		it("returns message when no active tasks to cancel", async () => {
			const manager = new BackgroundManager();
			const tool = createBackgroundCancelTool(manager);

			const result = await tool.execute(
				"call-1",
				{ all: true },
				undefined,
				vi.fn(),
				{} as unknown as Parameters<typeof tool.execute>[4],
			);

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toBe("No active tasks to cancel");
		});
	});

	describe("State reconstruction", () => {
		it("parses valid task entries correctly", () => {
			const manager = new BackgroundManager();
			const task: BackgroundTask = {
				id: "bg_1234abcd",
				description: "Restored task",
				prompt: "Do restored",
				model: undefined,
				status: "completed",
				pid: undefined,
				sessionPath: undefined,
				startedAt: new Date("2024-01-01"),
				completedAt: new Date("2024-01-02"),
				result: "Restored result",
				error: undefined,
				parentSessionId: "test-session",
			};

			manager.restoreTask(task);

			const restored = manager.getTask("bg_1234abcd");
			expect(restored).toBeDefined();
			expect(restored?.id).toBe("bg_1234abcd");
			expect(restored?.status).toBe("completed");
			expect(restored?.result).toBe("Restored result");
		});

		it("restores completed tasks from session entries on session_start", () => {
			// given
			const manager = new BackgroundManager();
			const completedTask: BackgroundTask = {
				id: "bg_test1234",
				description: "restored task",
				prompt: "test",
				model: undefined,
				status: "completed",
				pid: undefined,
				sessionPath: undefined,
				startedAt: new Date("2024-01-01"),
				completedAt: new Date("2024-01-01"),
				result: "restored result",
				error: undefined,
				parentSessionId: "parent",
			};

			// when - restore via restoreTask (simulating session_start reconstruction)
			manager.restoreTask(completedTask);

			// then
			const restored = manager.getTask("bg_test1234");
			expect(restored).toBeDefined();
			expect(restored?.status).toBe("completed");
			expect(restored?.result).toBe("restored result");
			expect(getWidgetLines(manager)).toBeUndefined(); // completed tasks don't show in widget
		});
	});
});
