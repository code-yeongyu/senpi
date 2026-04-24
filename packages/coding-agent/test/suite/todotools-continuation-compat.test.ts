import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import parallelToolCallsExtension from "../../src/core/extensions/builtin/parallel-tool-calls.js";
import { resolveContinuationConfig } from "../../src/core/extensions/builtin/todotools/continuation/config.js";
import { CONTINUATION_DIRECTIVE } from "../../src/core/extensions/builtin/todotools/continuation/prompt.js";
import todotoolsExtension, {
	getTodoResultLines,
	getTodoWidgetLines,
	TODO_STATE_ENTRY_TYPE,
	type TodoItem,
} from "../../src/core/extensions/builtin/todotools/index.js";
import type {
	Extension,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime,
	ExtensionUIContext,
} from "../../src/core/extensions/types.js";
import { assistantMsg, createTestExtensionsResult, createTestResourceLoader, userMsg } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

const PENDING_TODOS: TodoItem[] = [
	{ content: "Verify parallel compatibility", status: "in_progress", priority: "high" },
	{ content: "Confirm auto-dispatched continuation", status: "pending", priority: "medium" },
];

const SETTINGS_PRIORITY_CASES = [
	{
		name: "defaults to enabled when no settings or cli flag exist",
		globalSettings: undefined,
		projectSettings: undefined,
		cliFlag: undefined,
		expectedEnabled: true,
	},
	{
		name: "disables continuation when global settings set enabled false",
		globalSettings: todoSettings(false),
		projectSettings: undefined,
		cliFlag: undefined,
		expectedEnabled: false,
	},
	{
		name: "lets project settings override an enabled global setting",
		globalSettings: todoSettings(true),
		projectSettings: todoSettings(false),
		cliFlag: undefined,
		expectedEnabled: false,
	},
	{
		name: "lets the cli flag override a project-enabled setting",
		globalSettings: undefined,
		projectSettings: todoSettings(true),
		cliFlag: true,
		expectedEnabled: false,
	},
] as const;

function todoSettings(enabled: boolean): Record<string, unknown> {
	return {
		todotools: {
			continuation: {
				enabled,
			},
		},
	};
}

function trackTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function useIsolatedAgentDir(globalSettings?: Record<string, unknown>): string {
	const agentDir = trackTempDir("pi-agent-dir-");
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	if (globalSettings) {
		writeJson(join(agentDir, "settings.json"), globalSettings);
	}
	return agentDir;
}

function setProjectSettings(harness: Harness, settings: Record<string, unknown>): void {
	writeJson(join(harness.tempDir, ".pi", "settings.json"), settings);
}

function createMockUI(): {
	uiContext: ExtensionUIContext;
	setWidget: ReturnType<typeof vi.fn>;
} {
	const setWidget = vi.fn();
	return {
		setWidget,
		uiContext: {
			select: vi.fn().mockResolvedValue(undefined),
			confirm: vi.fn().mockResolvedValue(false),
			input: vi.fn().mockResolvedValue(undefined),
			notify: vi.fn(),
			onTerminalInput: vi.fn().mockReturnValue(() => {}),
			setStatus: vi.fn(),
			setWorkingMessage: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setWidget,
			setFooter: vi.fn(),
			setHeader: vi.fn(),
			setTitle: vi.fn(),
			custom: vi.fn().mockResolvedValue(undefined),
			pasteToEditor: vi.fn(),
			setEditorText: vi.fn(),
			getEditorText: vi.fn().mockReturnValue(""),
			editor: vi.fn().mockResolvedValue(undefined),
			setEditorComponent: vi.fn(),
			theme: {} as never,
		} as unknown as ExtensionUIContext,
	};
}

function createNoInjectionResponses(todos: TodoItem[]): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("todowrite", { todos })], { stopReason: "toolUse" }),
		fauxAssistantMessage("saved", { stopReason: "stop" }),
	];
}

function markTodosCompleted(todos: TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({
		...todo,
		status: "completed",
	}));
}

function createContinuationThenCompleteResponses(
	todos: TodoItem[],
	completedTodos: TodoItem[] = markTodosCompleted(todos),
): FauxResponseStep[] {
	return [
		...createNoInjectionResponses(todos),
		fauxAssistantMessage([fauxToolCall("todowrite", { todos: completedTodos })], { stopReason: "toolUse" }),
		fauxAssistantMessage("completed", { stopReason: "stop" }),
	];
}

function createStopThenCompleteResponses(completedTodos: TodoItem[]): FauxResponseStep[] {
	return [
		fauxAssistantMessage("continue", { stopReason: "stop" }),
		fauxAssistantMessage([fauxToolCall("todowrite", { todos: completedTodos })], { stopReason: "toolUse" }),
		fauxAssistantMessage("completed", { stopReason: "stop" }),
	];
}

function getInjectedContinuationMessages(harness: Harness): string[] {
	return harness.getInjectedUserMessages().filter((message) => message.includes(CONTINUATION_DIRECTIVE));
}

async function waitForHarnessToSettle(harness: Harness, timeoutMs = 1_500): Promise<void> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		if (!harness.session.isStreaming && harness.getPendingResponseCount() === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (!harness.session.isStreaming && harness.getPendingResponseCount() === 0) {
				return;
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	throw new Error("Timed out waiting for continuation dispatch to settle");
}

function createDelayedTool(name: string, delayMs: number, executions: string[]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId, params) => {
			const value = typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			executions.push(`${name}:${value}`);
			return {
				content: [{ type: "text", text: `${name}:${value}` }],
				details: { value },
			};
		},
	};
}

async function emitHandlers(
	extension: Extension,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of extension.handlers.get(eventName) ?? []) {
		await handler(event as never, ctx);
	}
}

function createExtensionContext(harness: Harness, uiContext: ExtensionUIContext): ExtensionContext {
	return {
		cwd: harness.tempDir,
		hasUI: true,
		sessionManager: harness.sessionManager,
		ui: uiContext,
	} as unknown as ExtensionContext;
}

function getTodotoolsExtension(extensions: Extension[]): Extension {
	const extension = extensions.find(
		(candidate) => candidate.handlers.has("agent_end") && candidate.handlers.has("session_tree"),
	);
	if (!extension) {
		throw new Error("Expected the todotools extension to be loaded");
	}
	return extension;
}

async function createTodoHarness(
	options: {
		extensionFactories?: ExtensionFactory[];
		tools?: AgentTool[];
		beforeBind?: (harness: Harness) => void | Promise<void>;
	} = {},
): Promise<{
	harness: Harness;
	runtime: ExtensionRuntime;
	extensions: Extension[];
	ui: ReturnType<typeof createMockUI>;
}> {
	const extensionsResult = await createTestExtensionsResult(
		options.extensionFactories ?? [todotoolsExtension],
		REPO_ROOT,
	);
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: options.tools,
	});

	if (options.beforeBind) {
		await options.beforeBind(harness);
	}

	const ui = createMockUI();
	await harness.session.bindExtensions({
		uiContext: ui.uiContext,
		shutdownHandler: () => {},
	});
	harnesses.push(harness);

	return {
		harness,
		runtime: extensionsResult.runtime,
		extensions: extensionsResult.extensions,
		ui,
	};
}

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("todotools continuation compatibility", () => {
	it("keeps the public todotools exports used by the existing todowrite coverage stable", () => {
		const todos: TodoItem[] = [
			{ content: "Active task", status: "in_progress", priority: "high" },
			{ content: "Done task", status: "completed", priority: "low" },
			{ content: "Queued task", status: "pending", priority: "medium" },
		];

		expect(TODO_STATE_ENTRY_TYPE).toBe("sanepi.todo-state");
		expect(getTodoWidgetLines(todos)).toEqual(["Todo", "[•] Active task", "[✓] Done task", "[ ] Queued task"]);
		expect(getTodoResultLines(todos)).toEqual(["2 todos", "[•] Active task", "[✓] Done task", "[ ] Queued task"]);
	});

	it("preserves sidebar widget lines before and after a warranted continuation for the same todo state", async () => {
		useIsolatedAgentDir();
		const seededTodos: TodoItem[] = [
			{ content: "Preserve sidebar output", status: "in_progress", priority: "high" },
			{ content: "Leave one item pending", status: "pending", priority: "medium" },
		];
		const expectedLines = getTodoWidgetLines(seededTodos);
		const { harness, ui } = await createTodoHarness({
			beforeBind: (sessionHarness) => {
				sessionHarness.sessionManager.appendMessage(userMsg("seed todo state"));
				sessionHarness.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, { todos: seededTodos });
			},
		});
		harness.setResponses(createContinuationThenCompleteResponses(seededTodos));

		await harness.session.prompt("continue the seeded work");
		await waitForHarnessToSettle(harness);

		const todoWidgetCalls = ui.setWidget.mock.calls.filter(([widgetId]) => widgetId === "todo-sidebar");
		expect(todoWidgetCalls.map(([, lines]) => lines).slice(0, 2)).toEqual([expectedLines, expectedLines]);
		expect(getInjectedContinuationMessages(harness)).toHaveLength(1);
	});

	it("restores branch todos on session_tree and allows a fresh agent_end continuation on the new branch", async () => {
		useIsolatedAgentDir();
		const mainBranchTodos: TodoItem[] = [{ content: "Main branch task", status: "pending", priority: "high" }];
		const alternateBranchTodos: TodoItem[] = [
			{ content: "Alternate branch task", status: "in_progress", priority: "medium" },
		];
		let mainBranchLeafId = "";
		let alternateBranchLeafId = "";

		const { harness, extensions, ui } = await createTodoHarness({
			beforeBind: (sessionHarness) => {
				sessionHarness.sessionManager.appendMessage(userMsg("root prompt"));
				const branchPointId = sessionHarness.sessionManager.appendMessage(assistantMsg("branch point"));
				sessionHarness.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, { todos: mainBranchTodos });
				mainBranchLeafId = sessionHarness.sessionManager.getLeafId() ?? "";

				sessionHarness.sessionManager.branch(branchPointId);
				sessionHarness.sessionManager.appendMessage(userMsg("alternate branch prompt"));
				sessionHarness.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, { todos: alternateBranchTodos });
				alternateBranchLeafId = sessionHarness.sessionManager.getLeafId() ?? "";

				sessionHarness.sessionManager.branch(mainBranchLeafId);
			},
		});
		const todotools = getTodotoolsExtension(extensions);
		const ctx = createExtensionContext(harness, ui.uiContext);

		harness.setResponses(createStopThenCompleteResponses(markTodosCompleted(mainBranchTodos)));
		await harness.session.prompt("run the main branch");
		await waitForHarnessToSettle(harness);
		expect(getInjectedContinuationMessages(harness)).toHaveLength(1);

		harness.sessionManager.branch(alternateBranchLeafId);
		await emitHandlers(
			todotools,
			"session_tree",
			{ type: "session_tree", oldLeafId: mainBranchLeafId, newLeafId: alternateBranchLeafId },
			ctx,
		);
		expect(ui.setWidget).toHaveBeenLastCalledWith("todo-sidebar", getTodoWidgetLines(alternateBranchTodos));

		harness.setResponses(createStopThenCompleteResponses(markTodosCompleted(alternateBranchTodos)));
		await harness.session.prompt("run the alternate branch");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(2);
		expect(getInjectedContinuationMessages(harness)[1]).toContain("Alternate branch task");
	});

	it("fires continuation exactly once after a multi-tool turn when parallel-tool-calls is active", async () => {
		useIsolatedAgentDir();
		const toolExecutions: string[] = [];
		const { harness } = await createTodoHarness({
			extensionFactories: [parallelToolCallsExtension, todotoolsExtension],
			tools: [createDelayedTool("slow", 25, toolExecutions)],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("slow", { value: "aux" }), fauxToolCall("todowrite", { todos: PENDING_TODOS })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("tool turn complete", { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("todowrite", { todos: markTodosCompleted(PENDING_TODOS) })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("completed", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run multiple tools in one turn");
		await waitForHarnessToSettle(harness);

		expect(toolExecutions).toEqual(["slow:aux"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
		expect(getInjectedContinuationMessages(harness)).toHaveLength(1);
	});

	it.each(SETTINGS_PRIORITY_CASES)(
		"$name",
		async ({ globalSettings, projectSettings, cliFlag, expectedEnabled, name }) => {
			useIsolatedAgentDir(globalSettings);
			const { harness, runtime } = await createTodoHarness();

			if (projectSettings) {
				setProjectSettings(harness, projectSettings);
			}
			if (cliFlag !== undefined) {
				runtime.flagValues.set("disable-todo-continuation", cliFlag);
			}

			expect(
				resolveContinuationConfig({
					globalSettings,
					projectSettings,
					cliFlag,
				}),
			).toEqual({ enabled: expectedEnabled });

			harness.setResponses(
				expectedEnabled
					? createContinuationThenCompleteResponses(PENDING_TODOS)
					: createNoInjectionResponses(PENDING_TODOS),
			);
			await harness.session.prompt(name);
			await waitForHarnessToSettle(harness);

			expect(getInjectedContinuationMessages(harness)).toHaveLength(expectedEnabled ? 1 : 0);
		},
	);
});
