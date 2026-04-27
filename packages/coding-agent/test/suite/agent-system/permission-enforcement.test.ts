import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ExtensionRunner } from "../../../src/core/extensions/runner.js";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.js";
import { theme } from "../../../src/modes/interactive/theme/theme.js";
import { createTestExtensionsResult } from "../../utilities.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const PERMISSION_SYSTEM_EXTENSION_PATH = fileURLToPath(
	new URL("../../../src/core/extensions/builtin/permission-system/index.ts", import.meta.url),
);

async function loadPermissionSystemExtension() {
	const module = await import(PERMISSION_SYSTEM_EXTENSION_PATH);
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

async function writePermissionSettings(tempDir: string, permissionConfig: Record<string, unknown>): Promise<void> {
	const piDir = path.join(tempDir, ".pi");
	await fs.mkdir(piDir, { recursive: true });
	await fs.writeFile(path.join(piDir, "settings.json"), JSON.stringify({ permission: permissionConfig }, null, 3));
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
		getServiceTier: () => undefined,
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
	permissionConfig?: Record<string, unknown>;
	tools?: AgentTool[];
	uiContext?: ExtensionUIContext;
}): Promise<{ runner: ExtensionRunner; tempDir: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-system-permission-"));
	const tools = options.tools ?? [createEchoTool()];
	const permissionSystemExtension = await loadPermissionSystemExtension();
	const extensionsResult = await createTestExtensionsResult([permissionSystemExtension], tempDir);
	const runner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		tempDir,
		SessionManager.inMemory(),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);

	runner.bindCore(createRunnerActions(tools), createRunnerContextActions());
	runner.setUIContext(options.uiContext);

	if (options.permissionConfig) {
		await writePermissionSettings(tempDir, options.permissionConfig);
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
		setWorkingIndicator: () => {},
		setWorkingVisible: () => {},
		addAutocompleteProvider: () => {},
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

describe("permission-system enforcement", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

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
	});

	it("returns a block result when a deny rule rejects the tool call", async () => {
		// given
		const { runner, tempDir } = await createPermissionRunner({
			tools: [createEchoTool()],
			permissionConfig: { echo: "deny" },
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
			reason: "The user has specified a rule which prevents you from using this specific tool call.",
		});
	});

	it("returns undefined and allows tool execution when permission allows the tool", async () => {
		// given
		const executedTools: string[] = [];
		const permissionSystemExtension = await loadPermissionSystemExtension();
		const harness = await createHarness({
			tools: [createEchoTool((text) => executedTools.push(text))],
			extensionFactories: [permissionSystemExtension],
		});
		harnesses.push(harness);
		await writePermissionSettings(harness.tempDir, { echo: "allow" });
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
		const executedTools: string[] = [];
		const permissionSystemExtension = await loadPermissionSystemExtension();
		const harness = await createHarness({
			tools: [createEchoTool((text) => executedTools.push(text))],
			extensionFactories: [permissionSystemExtension],
		});
		harnesses.push(harness);
		await writePermissionSettings(harness.tempDir, { echo: "ask" });
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "needs-ui" }), { stopReason: "toolUse" }),
			createToolResultResponder(),
		]);

		// when
		await harness.session.prompt("use echo");

		// then
		expect(executedTools).toEqual([]);
		const lastMessage = getMessageText(getMessageFromEnd(harness, 1));
		expect(lastMessage).toContain("Permission required for echo (*)");
		expect(lastMessage).toContain("--permission echo=allow");
	});

	it("reuses an allow always approval within the session and bypasses the second prompt", async () => {
		// given
		const executedTools: string[] = [];
		const permissionSystemExtension = await loadPermissionSystemExtension();
		const uiContext = createUiContext("Allow always");
		const harness = await createHarness({
			tools: [createEchoTool((text) => executedTools.push(text))],
			extensionFactories: [permissionSystemExtension],
		});
		harnesses.push(harness);
		await writePermissionSettings(harness.tempDir, { echo: "ask" });
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
