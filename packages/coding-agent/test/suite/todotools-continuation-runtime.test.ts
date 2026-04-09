import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { CONTINUATION_DIRECTIVE } from "../../src/core/extensions/builtin/todotools/continuation/prompt.js";
import { installContinuation } from "../../src/core/extensions/builtin/todotools/continuation/runtime.js";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.js";
import type { TodoItem } from "../../src/core/extensions/builtin/todotools/state.js";
import type {
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionRuntime,
	ExtensionUIContext,
} from "../../src/core/extensions/types.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

const PENDING_TODOS: TodoItem[] = [
	{ content: "Implement runtime coverage", status: "in_progress", priority: "high" },
	{ content: "Verify harness observability", status: "pending", priority: "medium" },
];

function todoSettings(enabled: boolean) {
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

async function createTodoHarness(
	extensionFactory: (pi: ExtensionAPI) => void = todotoolsExtension,
): Promise<{ harness: Harness; runtime: ExtensionRuntime; extension: Extension }> {
	const extensionsResult = await createTestExtensionsResult([extensionFactory], REPO_ROOT);
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	await harness.session.bindExtensions({
		uiContext: createMockUI(),
		shutdownHandler: () => {},
	});
	harnesses.push(harness);
	return { harness, runtime: extensionsResult.runtime, extension: extensionsResult.extensions[0]! };
}

function createNoInjectionResponses(todos: TodoItem[]): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("todowrite", { todos })], { stopReason: "toolUse" }),
		fauxAssistantMessage("saved"),
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
		fauxAssistantMessage("completed"),
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

function createDuplicatedAgentEndExtension(pi: ExtensionAPI): void {
	const originalOn = pi.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	const wrappedPi = Object.create(pi) as ExtensionAPI;

	wrappedPi.on = ((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
		originalOn(event, handler);
		if (event === "agent_end") {
			originalOn(event, handler);
		}
	}) as ExtensionAPI["on"];

	todotoolsExtension(wrappedPi);
}

function createThrowingContinuationExtension(pi: ExtensionAPI): void {
	installContinuation(pi, {
		getCurrentTodos: () => {
			throw new Error("todo state exploded");
		},
	});
}

function createMockUI(): ExtensionUIContext {
	return {
		select: vi.fn().mockResolvedValue(undefined),
		confirm: vi.fn().mockResolvedValue(false),
		input: vi.fn().mockResolvedValue(undefined),
		notify: vi.fn(),
		onTerminalInput: vi.fn().mockReturnValue(() => {}),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWidget: vi.fn(),
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
	} as unknown as ExtensionUIContext;
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

describe("todotools continuation runtime integration", () => {
	it("injects exactly one continuation follow-up by default when pending todos remain", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		harness.setResponses(createContinuationThenCompleteResponses(PENDING_TODOS));

		await harness.session.prompt("start the continuation test");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(1);
		expect(getInjectedContinuationMessages(harness)[0]).toContain(CONTINUATION_DIRECTIVE);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("does not inject when global settings disable continuation", async () => {
		useIsolatedAgentDir(todoSettings(false));
		const { harness } = await createTodoHarness();
		harness.setResponses(createNoInjectionResponses(PENDING_TODOS));

		await harness.session.prompt("respect global disable");

		expect(harness.getInjectedUserMessages()).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["respect global disable"]);
	});

	it("does not inject when project settings disable continuation", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		setProjectSettings(harness, todoSettings(false));
		harness.setResponses(createNoInjectionResponses(PENDING_TODOS));

		await harness.session.prompt("respect project disable");

		expect(harness.getInjectedUserMessages()).toEqual([]);
	});

	it("injects when project settings enable continuation over a disabled global setting", async () => {
		useIsolatedAgentDir(todoSettings(false));
		const { harness } = await createTodoHarness();
		setProjectSettings(harness, todoSettings(true));
		harness.setResponses(createContinuationThenCompleteResponses(PENDING_TODOS));

		await harness.session.prompt("project override wins");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(1);
	});

	it("does not inject when the CLI flag disables continuation even if settings enable it", async () => {
		useIsolatedAgentDir(todoSettings(true));
		const { harness, runtime } = await createTodoHarness();
		setProjectSettings(harness, todoSettings(true));
		runtime.flagValues.set("disable-todo-continuation", true);
		harness.setResponses(createNoInjectionResponses(PENDING_TODOS));

		await harness.session.prompt("flag override wins");

		expect(harness.getInjectedUserMessages()).toEqual([]);
	});

	it("keeps injection count at zero when incomplete todos exist but continuation is disabled", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		setProjectSettings(harness, todoSettings(false));
		harness.setResponses(createNoInjectionResponses(PENDING_TODOS));

		await harness.session.prompt("disabled with pending todos");

		expect(harness.getInjectedUserMessages()).toHaveLength(0);
	});

	it("does not inject when all todos are completed", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		const completedTodos: TodoItem[] = [
			{ content: "Done 1", status: "completed", priority: "high" },
			{ content: "Done 2", status: "completed", priority: "medium" },
		];
		harness.setResponses(createNoInjectionResponses(completedTodos));

		await harness.session.prompt("all done");

		expect(harness.getInjectedUserMessages()).toEqual([]);
	});

	it("does not inject when the todo list is empty", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		harness.setResponses(createNoInjectionResponses([]));

		await harness.session.prompt("empty list");

		expect(harness.getInjectedUserMessages()).toEqual([]);
	});

	it("injects only the in-progress and pending items for mixed todo statuses", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		const mixedTodos: TodoItem[] = [
			{ content: "Done task", status: "completed", priority: "low" },
			{ content: "Active task", status: "in_progress", priority: "high" },
			{ content: "Queued task", status: "pending", priority: "medium" },
			{ content: "Cancelled task", status: "cancelled", priority: "low" },
		];
		harness.setResponses(createContinuationThenCompleteResponses(mixedTodos));

		await harness.session.prompt("mixed statuses");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(1);
		expect(getInjectedContinuationMessages(harness)[0]).toContain("- [in_progress] Active task");
		expect(getInjectedContinuationMessages(harness)[0]).toContain("- [pending] Queued task");
		expect(getInjectedContinuationMessages(harness)[0]).not.toContain("- [completed] Done task");
		expect(getInjectedContinuationMessages(harness)[0]).not.toContain("- [cancelled] Cancelled task");
	});

	it("injects only once when the same agent_end handler is registered twice in one cycle", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness(createDuplicatedAgentEndExtension);
		harness.setResponses(createContinuationThenCompleteResponses(PENDING_TODOS));

		await harness.session.prompt("duplicate handler");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(1);
	});

	it("injects once per warranted cycle when a fresh user prompt arrives between cycles", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		const firstTodos: TodoItem[] = [{ content: "First cycle todo", status: "pending", priority: "high" }];
		const secondTodos: TodoItem[] = [{ content: "Second cycle todo", status: "pending", priority: "high" }];
		harness.setResponses(createContinuationThenCompleteResponses(firstTodos));

		await harness.session.prompt("first cycle");
		await waitForHarnessToSettle(harness);
		harness.setResponses(createContinuationThenCompleteResponses(secondTodos));
		await harness.session.prompt("second cycle");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(2);
		expect(getInjectedContinuationMessages(harness)[0]).toContain("First cycle todo");
		expect(getInjectedContinuationMessages(harness)[1]).toContain("Second cycle todo");
	});

	it("does not inject after an aborted agent turn when incomplete todos already exist", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		setProjectSettings(harness, todoSettings(false));
		harness.setResponses(createNoInjectionResponses(PENDING_TODOS));

		await harness.session.prompt("seed pending todos");
		setProjectSettings(harness, todoSettings(true));
		harness.setResponses([fauxAssistantMessage("aborted", { stopReason: "aborted" })]);

		await harness.session.prompt("abort the run");

		expect(harness.getInjectedUserMessages()).toHaveLength(0);
	});

	it("does not inject after an error agent turn when incomplete todos already exist", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness();
		setProjectSettings(harness, todoSettings(false));
		harness.setResponses(createNoInjectionResponses(PENDING_TODOS));

		await harness.session.prompt("seed pending todos");
		setProjectSettings(harness, todoSettings(true));
		harness.setResponses([fauxAssistantMessage("errored", { stopReason: "error" })]);

		await harness.session.prompt("error the run");

		expect(harness.getInjectedUserMessages()).toHaveLength(0);
	});

	it("catches handler errors and keeps the session usable without unhandled rejections", async () => {
		useIsolatedAgentDir();
		const { harness } = await createTodoHarness(createThrowingContinuationExtension);
		const unhandledRejection = vi.fn();
		process.on("unhandledRejection", unhandledRejection);

		try {
			harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);

			await harness.session.prompt("first prompt");
			await harness.session.prompt("second prompt");
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(getAssistantTexts(harness)).toEqual(["first response", "second response"]);
			expect(harness.getInjectedUserMessages()).toEqual([]);
			expect(unhandledRejection).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandledRejection);
		}
	});

	it("isolates continuation state across two concurrent harness sessions", async () => {
		useIsolatedAgentDir();
		const [{ harness: firstHarness }, { harness: secondHarness }] = await Promise.all([
			createTodoHarness(),
			createTodoHarness(),
		]);
		const firstTodos: TodoItem[] = [{ content: "First harness todo", status: "pending", priority: "high" }];
		const secondTodos: TodoItem[] = [{ content: "Second harness todo", status: "pending", priority: "high" }];
		firstHarness.setResponses(createContinuationThenCompleteResponses(firstTodos));
		secondHarness.setResponses(createContinuationThenCompleteResponses(secondTodos));

		await Promise.all([
			firstHarness.session.prompt("first concurrent prompt"),
			secondHarness.session.prompt("second concurrent prompt"),
		]);
		await Promise.all([waitForHarnessToSettle(firstHarness), waitForHarnessToSettle(secondHarness)]);

		expect(getInjectedContinuationMessages(firstHarness)).toHaveLength(1);
		expect(getInjectedContinuationMessages(secondHarness)).toHaveLength(1);
		expect(getInjectedContinuationMessages(firstHarness)[0]).toContain("First harness todo");
		expect(getInjectedContinuationMessages(firstHarness)[0]).not.toContain("Second harness todo");
		expect(getInjectedContinuationMessages(secondHarness)[0]).toContain("Second harness todo");
		expect(getInjectedContinuationMessages(secondHarness)[0]).not.toContain("First harness todo");
	});

	it("injects again after session shutdown and reload clear the per-session state", async () => {
		useIsolatedAgentDir();
		const { harness, extension } = await createTodoHarness();
		const firstTodos: TodoItem[] = [{ content: "Before reload", status: "pending", priority: "high" }];
		const secondTodos: TodoItem[] = [{ content: "After reload", status: "pending", priority: "high" }];
		const uiContext = createMockUI();
		const ctx = {
			cwd: harness.tempDir,
			hasUI: true,
			sessionManager: harness.sessionManager,
			ui: uiContext,
		} as unknown as ExtensionContext;
		harness.setResponses(createContinuationThenCompleteResponses(firstTodos));

		await harness.session.prompt("before reload");
		await waitForHarnessToSettle(harness);

		for (const handler of extension.handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown" }, ctx);
		}
		for (const handler of extension.handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "reload" }, ctx);
		}
		harness.setResponses(createContinuationThenCompleteResponses(secondTodos));
		await harness.session.prompt("after reload");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(2);
		expect(getInjectedContinuationMessages(harness)[0]).toContain("Before reload");
		expect(getInjectedContinuationMessages(harness)[1]).toContain("After reload");
	});
});
