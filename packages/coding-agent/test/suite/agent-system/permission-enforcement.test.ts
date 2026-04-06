import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { AGENT_TYPE_ENV_VAR } from "../../../src/core/extensions/builtin/background-task/types.js";
import { ExtensionRunner } from "../../../src/core/extensions/runner.js";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.js";
import { theme } from "../../../src/modes/interactive/theme/theme.js";
import { createTestExtensionsResult } from "../../utilities.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const AGENT_SYSTEM_EXTENSION_PATH = fileURLToPath(
	new URL("../../../src/core/extensions/builtin/agent-system/index.ts", import.meta.url),
);

async function loadAgentSystemExtension() {
	const module = await import(AGENT_SYSTEM_EXTENSION_PATH);
	return module.default;
}

function createEchoTool(onExecute?: (text: string) => void): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			onExecute?.(text);
			return {
				content: [{ type: "text", text: `echo:${text}` }],
				details: { text },
			};
		},
	};
}

async function writeAgentFile(harness: Harness, agentName: string, body: string): Promise<void> {
	const agentDir = path.join(harness.tempDir, ".sanepi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, `${agentName}.md`), body);
}

function createToolResultResponder() {
	return (context: { messages: Array<{ role: string; content?: unknown }> }) => {
		const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
		return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "missing tool result");
	};
}

function createRunnerActions(tools: AgentTool[]) {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => tools.map((tool) => tool.name),
		getAllTools: () =>
			tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				sourceInfo: createSyntheticSourceInfo(`<test:${tool.name}>`, { source: "test" }),
			})),
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: (): ThinkingLevel => "medium",
		setThinkingLevel: () => {},
	};
}

function createRunnerContextActions() {
	return {
		getModel: () => undefined,
		isIdle: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

async function createPermissionRunner(options: {
	agentType: string;
	agentFileBody?: string;
	tools?: AgentTool[];
	uiContext?: ExtensionUIContext;
}): Promise<{ runner: ExtensionRunner; tempDir: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-system-permission-"));
	const tools = options.tools ?? [createEchoTool()];
	const agentSystemExtension = await loadAgentSystemExtension();
	const extensionsResult = await createTestExtensionsResult([agentSystemExtension], tempDir);
	const runner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		tempDir,
		SessionManager.inMemory(),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);

	runner.bindCore(createRunnerActions(tools), createRunnerContextActions());
	runner.setUIContext(options.uiContext);

	if (options.agentFileBody) {
		const agentDir = path.join(tempDir, ".sanepi", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, `${options.agentType}.md`), options.agentFileBody);
	}

	await runner.emit({ type: "session_start", reason: "startup" });

	return { runner, tempDir };
}

function getMessageFromEnd(harness: Harness, offsetFromEnd: number) {
	return harness.session.messages[harness.session.messages.length - offsetFromEnd];
}

function createUiContext(selection: string | undefined): ExtensionUIContext {
	return {
		select: vi.fn(async () => selection),
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>(): Promise<T> => {
			throw new Error("custom UI not implemented in test");
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		setEditorComponent: () => {},
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => true,
		setToolsExpanded: () => {},
	};
}

describe("agent-system permission enforcement", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];
	const originalAgentType = process.env[AGENT_TYPE_ENV_VAR];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				void fs.rm(tempDir, { recursive: true, force: true });
			}
		}

		if (originalAgentType === undefined) {
			delete process.env[AGENT_TYPE_ENV_VAR];
		} else {
			process.env[AGENT_TYPE_ENV_VAR] = originalAgentType;
		}
	});

	it("returns block result with agent and tool name when permission denies the tool", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = "explore";
		const { runner, tempDir } = await createPermissionRunner({
			agentType: "explore",
			tools: [createEchoTool()],
		});
		tempDirs.push(tempDir);

		// when
		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "echo",
			input: { text: "blocked" },
		});

		// then
		expect(result).toEqual({
			block: true,
			reason:
				'Agent "explore" does not have permission to use "echo". This tool is denied by the agent\'s permission policy.',
		});
	});

	it("returns undefined and allows tool execution when permission allows the tool", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = "general";
		const executedTools: string[] = [];
		const agentSystemExtension = await loadAgentSystemExtension();
		const harness = await createHarness({
			tools: [createEchoTool((text) => executedTools.push(text))],
			extensionFactories: [agentSystemExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "allowed" }), { stopReason: "toolUse" }),
			createToolResultResponder(),
		]);

		// when
		await harness.session.prompt("use echo");

		// then
		expect(executedTools).toEqual(["allowed"]);
		expect(getMessageText(getMessageFromEnd(harness, 2))).toBe("echo:allowed");
		expect(getMessageText(getMessageFromEnd(harness, 1))).toBe("echo:allowed");
	});

	it("auto-denies ask mode without UI and explains that no UI is available", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = "ask-without-ui";
		const agentSystemExtension = await loadAgentSystemExtension();
		const harness = await createHarness({
			tools: [createEchoTool()],
			extensionFactories: [agentSystemExtension],
		});
		harnesses.push(harness);
		await writeAgentFile(
			harness,
			"ask-without-ui",
			`---
tools:
  echo: ask
---
Requires confirmation.\n`,
		);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "needs-ui" }), { stopReason: "toolUse" }),
			createToolResultResponder(),
		]);

		// when
		await harness.session.prompt("use echo");

		// then
		expect(getMessageText(getMessageFromEnd(harness, 2))).toContain("no UI is available");
		expect(getMessageText(getMessageFromEnd(harness, 1))).toContain("no UI is available");
	});

	it("remembers allow always in a session-local set and bypasses the second prompt", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = "ask-with-ui";
		const executedTools: string[] = [];
		const agentSystemExtension = await loadAgentSystemExtension();
		const uiContext = createUiContext("Allow always");
		const harness = await createHarness({
			tools: [createEchoTool((text) => executedTools.push(text))],
			extensionFactories: [agentSystemExtension],
		});
		harnesses.push(harness);
		await writeAgentFile(
			harness,
			"ask-with-ui",
			`---
tools:
  echo: ask
---
Requires confirmation.\n`,
		);
		await harness.session.bindExtensions({ uiContext });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "first" }), { stopReason: "toolUse" }),
			createToolResultResponder(),
			fauxAssistantMessage(fauxToolCall("echo", { text: "second" }), { stopReason: "toolUse" }),
			createToolResultResponder(),
		]);

		// when
		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");

		// then
		expect(executedTools).toEqual(["first", "second"]);
		expect(uiContext.select).toHaveBeenCalledTimes(1);
		expect(getMessageText(getMessageFromEnd(harness, 2))).toBe("echo:second");
		expect(getMessageText(getMessageFromEnd(harness, 1))).toBe("echo:second");
	});
});
