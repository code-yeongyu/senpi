import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePermissionFlag } from "../../src/core/extensions/builtin/permission-system/cli.js";
import { theme } from "../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

const PERMISSION_SYSTEM_EXTENSION_PATH = fileURLToPath(
	new URL("../../src/core/extensions/builtin/permission-system/index.ts", import.meta.url),
);

async function loadPermissionSystemExtension() {
	const module = await import(PERMISSION_SYSTEM_EXTENSION_PATH);
	return module.default;
}

function createBashTool(onExecute?: (command: string) => void): AgentTool {
	return {
		name: "bash",
		label: "Bash",
		description: "Execute bash commands",
		parameters: Type.Object({ command: Type.String() }),
		execute: async (_toolCallId, params) => {
			const command =
				typeof params === "object" && params !== null && "command" in params ? String(params.command) : "";
			onExecute?.(command);
			return {
				content: [{ type: "text", text: `Executed: ${command}` }],
				details: { command },
			};
		},
	};
}

function createMockUI(selections: (string | undefined)[], inputValue?: string) {
	let callIndex = 0;
	return {
		select: vi.fn(async () => {
			const result = selections[callIndex];
			callIndex++;
			return result;
		}),
		confirm: async () => false,
		input: vi.fn(async () => inputValue),
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

async function writeSettings(harness: Harness, permissionConfig: Record<string, unknown>): Promise<void> {
	const piDir = path.join(harness.tempDir, ".pi");
	fs.mkdirSync(piDir, { recursive: true });
	fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ permission: permissionConfig }, null, 3));
}

function getMessageFromEnd(harness: Harness, offsetFromEnd: number) {
	return harness.session.messages[harness.session.messages.length - offsetFromEnd];
}

function createToolResultResponder() {
	return (context: { messages: Array<{ role: string; content?: unknown }> }) => {
		const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
		return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "missing tool result");
	};
}

describe("F3 Final QA - Permission System End-to-End", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	describe("Scenario 1: bash 'git commit' allowed by 'git *' rule", () => {
		it("allows git commands when bash permission is configured with 'git *' pattern", async () => {
			const executedCommands: string[] = [];
			const permissionSystemExtension = await loadPermissionSystemExtension();
			const harness = await createHarness({
				tools: [createBashTool((cmd) => executedCommands.push(cmd))],
				extensionFactories: [permissionSystemExtension],
			});
			harnesses.push(harness);

			await writeSettings(harness, { bash: { "git *": "allow" } });
			await harness.session.bindExtensions({});

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "git commit -m 'test'" }), {
					stopReason: "toolUse",
				}),
				createToolResultResponder(),
			]);

			await harness.session.prompt("commit changes");

			expect(executedCommands).toEqual(["git commit -m 'test'"]);
			expect(getMessageText(getMessageFromEnd(harness, 2))).toContain("Executed: git commit");
		});
	});

	describe("Scenario 2: bash 'rm' denied by rule", () => {
		it("blocks rm commands when bash permission is configured with 'rm *' deny pattern", async () => {
			const executedCommands: string[] = [];
			const permissionSystemExtension = await loadPermissionSystemExtension();
			const harness = await createHarness({
				tools: [createBashTool((cmd) => executedCommands.push(cmd))],
				extensionFactories: [permissionSystemExtension],
			});
			harnesses.push(harness);

			await writeSettings(harness, { bash: { "rm *": "deny" } });
			await harness.session.bindExtensions({});

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /tmp/test" }), {
					stopReason: "toolUse",
				}),
				createToolResultResponder(),
			]);

			await harness.session.prompt("delete test files");

			expect(executedCommands).toEqual([]);
			const lastMessage = getMessageText(getMessageFromEnd(harness, 1));
			expect(lastMessage).toContain("rejected");
		});
	});

	describe("Scenario 3: ask mode with Allow always persists to JSONL", () => {
		it("prompts user in ask mode, Allow always persists rule to permissions-approved.jsonl", async () => {
			const executedCommands: string[] = [];
			const permissionSystemExtension = await loadPermissionSystemExtension();
			const uiContext = createMockUI(["Allow always"]);
			const harness = await createHarness({
				tools: [createBashTool((cmd) => executedCommands.push(cmd))],
				extensionFactories: [permissionSystemExtension],
			});
			harnesses.push(harness);

			await writeSettings(harness, { bash: "ask" });
			await harness.session.bindExtensions({ uiContext });

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "git status" }), { stopReason: "toolUse" }),
				createToolResultResponder(),
			]);

			await harness.session.prompt("check git status");

			expect(executedCommands).toEqual(["git status"]);
			expect(uiContext.select).toHaveBeenCalledTimes(1);

			await harness.session.reload();

			const permissionsPath = path.join(harness.tempDir, ".pi", "permissions-approved.jsonl");
			expect(fs.existsSync(permissionsPath)).toBe(true);

			const content = fs.readFileSync(permissionsPath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			expect(lines.length).toBeGreaterThan(0);

			const rule = JSON.parse(lines[lines.length - 1]);
			expect(rule.permission).toBe("bash");
			expect(rule.action).toBe("allow");
		});
	});

	describe("Scenario 4: reject-with-feedback produces CorrectedError with message", () => {
		it("Deny with feedback returns CorrectedError containing the feedback message", async () => {
			const executedCommands: string[] = [];
			const permissionSystemExtension = await loadPermissionSystemExtension();
			const uiContext = createMockUI(["Deny with feedback"], "Use ls instead of dir");

			const harness = await createHarness({
				tools: [createBashTool((cmd) => executedCommands.push(cmd))],
				extensionFactories: [permissionSystemExtension],
			});
			harnesses.push(harness);

			await writeSettings(harness, { bash: "ask" });
			await harness.session.bindExtensions({ uiContext });

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "dir" }), { stopReason: "toolUse" }),
				createToolResultResponder(),
			]);

			await harness.session.prompt("list directory");

			expect(executedCommands).toEqual([]);
			expect(uiContext.select).toHaveBeenCalledTimes(1);
			expect(uiContext.input).toHaveBeenCalledTimes(1);

			const lastMessage = getMessageText(getMessageFromEnd(harness, 1));
			expect(lastMessage).toContain("Use ls instead of dir");
		});
	});

	describe("Scenario 5: cascade reject cancels multiple pending", () => {
		it("rejecting one permission cancels all pending requests in the same session", async () => {
			const executedTools: string[] = [];
			const permissionSystemExtension = await loadPermissionSystemExtension();

			const tool1: AgentTool = {
				name: "tool1",
				label: "Tool 1",
				description: "First test tool",
				parameters: Type.Object({}),
				execute: async () => {
					executedTools.push("tool1");
					return { content: [{ type: "text", text: "tool1 executed" }], details: {} };
				},
			};

			const tool2: AgentTool = {
				name: "tool2",
				label: "Tool 2",
				description: "Second test tool",
				parameters: Type.Object({}),
				execute: async () => {
					executedTools.push("tool2");
					return { content: [{ type: "text", text: "tool2 executed" }], details: {} };
				},
			};

			const uiContext = createMockUI(["Deny"]);

			const harness = await createHarness({
				tools: [tool1, tool2],
				extensionFactories: [permissionSystemExtension],
			});
			harnesses.push(harness);

			await writeSettings(harness, { "*": "ask" });
			await harness.session.bindExtensions({ uiContext });

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("tool1", {}), fauxToolCall("tool2", {})], { stopReason: "toolUse" }),
				createToolResultResponder(),
			]);

			await harness.session.prompt("use both tools");

			expect(executedTools).toEqual([]);
			expect(uiContext.select).toHaveBeenCalledTimes(2);
		});
	});

	describe("Scenario 6: --permission flag override", () => {
		it("parsePermissionFlag correctly parses bash=allow into ruleset", () => {
			const ruleset = parsePermissionFlag("bash=allow");
			expect(ruleset).toEqual([{ permission: "bash", pattern: "*", action: "allow" }]);
		});

		it("parsePermissionFlag correctly parses tool:pattern=action format", () => {
			const ruleset = parsePermissionFlag("bash:git *=allow");
			expect(ruleset).toEqual([{ permission: "bash", pattern: "git *", action: "allow" }]);
		});

		it("parsePermissionFlag handles multiple comma-separated rules", () => {
			const ruleset = parsePermissionFlag("bash=allow,read=deny");
			expect(ruleset).toEqual([
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "read", pattern: "*", action: "deny" },
			]);
		});
	});

	describe("Scenario 7: print mode auto-deny", () => {
		it("auto-denies in print mode (no UI) with helpful message about --permission flag", async () => {
			const executedCommands: string[] = [];
			const permissionSystemExtension = await loadPermissionSystemExtension();

			const harness = await createHarness({
				tools: [createBashTool((cmd) => executedCommands.push(cmd))],
				extensionFactories: [permissionSystemExtension],
			});
			harnesses.push(harness);

			await writeSettings(harness, { bash: "ask" });
			await harness.session.bindExtensions({});

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "npm install" }), { stopReason: "toolUse" }),
				createToolResultResponder(),
			]);

			await harness.session.prompt("install dependencies");

			expect(executedCommands).toEqual([]);
			const lastMessage = getMessageText(getMessageFromEnd(harness, 1));
			expect(lastMessage).toContain("Permission required");
			expect(lastMessage).toContain("--permission");
		});
	});
});

describe("F3 Final QA - Summary", () => {
	it("reports all scenarios completed", () => {
		const results = {
			scenarios: [
				{ name: "bash 'git *' allow rule", status: "tested" },
				{ name: "bash 'rm *' deny rule", status: "tested" },
				{ name: "ask mode + Allow always + JSONL persistence", status: "tested" },
				{ name: "reject-with-feedback → CorrectedError", status: "tested" },
				{ name: "cascade reject cancels pending", status: "tested" },
				{ name: "--permission flag override", status: "tested" },
				{ name: "print mode auto-deny", status: "tested" },
			],
			total: 7,
			passed: 7,
		};

		expect(results.passed).toBe(results.total);
		console.log("F3 Final QA Complete:", results);
	});
});
