import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { SANEPI_SYSTEM_PREFIX } from "../../src/core/extensions/builtin/system-messages.js";
import {
	buildContinuationPrompt,
	CONTINUATION_DIRECTIVE,
} from "../../src/core/extensions/builtin/todotools/continuation/prompt.js";
import { CONTINUATION_CHAIN_CAP } from "../../src/core/extensions/builtin/todotools/continuation/runtime.js";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.js";
import type { TodoItem } from "../../src/core/extensions/builtin/todotools/state.js";
import type { ExtensionRuntime, ExtensionUIContext } from "../../src/core/extensions/types.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

const PENDING_TODOS: TodoItem[] = [
	{ content: "Keep working on the first task", status: "in_progress", priority: "high" },
	{ content: "Leave the second task pending", status: "pending", priority: "medium" },
];

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

async function createTodoHarness(): Promise<{ harness: Harness; runtime: ExtensionRuntime }> {
	const extensionsResult = await createTestExtensionsResult([todotoolsExtension], REPO_ROOT);
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	await harness.session.bindExtensions({
		uiContext: createMockUI(),
		shutdownHandler: () => {},
	});
	harnesses.push(harness);
	return { harness, runtime: extensionsResult.runtime };
}

function createNoCompletionResponses(todos: TodoItem[]): FauxResponseStep[] {
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

function getInjectedContinuationMessages(harness: Harness): string[] {
	return harness.getInjectedUserMessages().filter((message) => message.includes(CONTINUATION_DIRECTIVE));
}

async function waitForHarnessToSettle(harness: Harness, timeoutMs = 2_000): Promise<void> {
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

describe("todotools continuation chain cap", () => {
	it("caps consecutive continuation injections at 10 and resets after a fresh user prompt", async () => {
		useIsolatedAgentDir();
		const { harness, runtime } = await createTodoHarness();

		runtime.flagValues.set("disable-todo-continuation", true);
		harness.setResponses(createNoCompletionResponses(PENDING_TODOS));
		await harness.session.prompt("seed todos without continuation");
		runtime.flagValues.set("disable-todo-continuation", false);
		harness.setResponses(
			Array.from({ length: CONTINUATION_CHAIN_CAP + 1 }, () =>
				fauxAssistantMessage("still not done", { stopReason: "stop" }),
			),
		);
		await harness.session.prompt("kick off the automatic continuation chain");
		await waitForHarnessToSettle(harness);

		const injectedMessages = getInjectedContinuationMessages(harness);
		expect(injectedMessages).toHaveLength(CONTINUATION_CHAIN_CAP);
		expect(injectedMessages).toEqual(
			Array.from(
				{ length: CONTINUATION_CHAIN_CAP },
				() => `${SANEPI_SYSTEM_PREFIX}\n${buildContinuationPrompt(PENDING_TODOS)}`,
			),
		);

		harness.setResponses([
			fauxAssistantMessage("fresh prompt finished", { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("todowrite", { todos: markTodosCompleted(PENDING_TODOS) })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("completed", { stopReason: "stop" }),
		]);
		await harness.session.prompt("fresh user prompt resets the chain");
		await waitForHarnessToSettle(harness);

		expect(getInjectedContinuationMessages(harness)).toHaveLength(CONTINUATION_CHAIN_CAP + 1);
		expect(getInjectedContinuationMessages(harness).at(-1)).toContain(CONTINUATION_DIRECTIVE);
	});
});
