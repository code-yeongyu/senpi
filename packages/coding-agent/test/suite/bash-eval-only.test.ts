import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runEvalSchema } from "../../../senpi-codemode/src/bridges/schema-bridge.ts";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));
const { createExecuteTool } = await import("../../../senpi-codemode/src/extension/runtime-factory.ts");

const MONITOR_HINT = 'tool.monitor({ description: "...", command: "...", filter: "..." })';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

interface EvalHarnessOptions {
	withEval?: boolean;
	excludedToolNames?: string[];
	evalOnlyToolNames?: string[];
	fileSettings?: boolean;
}

async function createEvalHarness(options: EvalHarnessOptions = {}) {
	const extensionFactory: ExtensionFactory = (pi) => {
		if (options.withEval !== false) {
			pi.registerTool({
				name: "eval",
				label: "Eval",
				description: "Evaluate code",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
			});
		}
		pi.registerTool({
			name: "workflow",
			label: "Workflow",
			description: "Run a workflow action",
			parameters: Type.Object({ action: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `workflow-ran:${params.action}` }],
				details: {},
			}),
		});
		pi.registerTool({
			name: "monitor",
			label: "Monitor",
			description: "Subscribe to command output",
			parameters: Type.Object({
				description: Type.Optional(Type.String()),
				command: Type.Optional(Type.String()),
				filter: Type.Optional(Type.String()),
			}),
			execute: async (_toolCallId, params) => ({
				content: [
					{
						type: "text",
						text: `monitor-ran:${params.description}:${params.command}:${params.filter ?? ""}`,
					},
				],
				details: {},
			}),
		});
	};
	const harness = await createHarness({
		extensionFactories: [extensionFactory],
		excludedToolNames: options.excludedToolNames,
		evalOnlyToolNames: options.evalOnlyToolNames,
		fileSettings: options.fileSettings,
	});
	return { harness };
}

const allPolicyTools = ["bash", "powershell", "workflow", "monitor"];
const allRequestedTools = ["read", ...allPolicyTools, "edit", "write"];

describe("default eval-only tool policy", () => {
	it("arms by default and hides every registered policy tool", async () => {
		const { harness } = await createEvalHarness();
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write"]);
			expect(harness.session.systemPrompt).toContain("tool.bash(");
			expect(harness.session.systemPrompt).toContain("tool.powershell(");
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
			expect(harness.session.systemPrompt).toContain("tool.monitor(");
		} finally {
			harness.cleanup();
		}
	});

	it("executes hidden bash and monitor through the registry without reactivating either tool", async () => {
		const { harness } = await createEvalHarness();
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			expect(textOf(await harness.session.executeTool("bash", { command: "echo hi" }))).toContain("hi");
			expect(
				textOf(
					await harness.session.executeTool(
						"monitor",
						{ description: "watch build", command: "printf READY", filter: "^READY$" },
						{ activateInactiveTool: true },
					),
				),
			).toContain("monitor-ran:watch build:printf READY:^READY$");
			expect(harness.session.getActiveToolNames()).not.toContain("bash");
			expect(harness.session.getActiveToolNames()).not.toContain("monitor");
		} finally {
			harness.cleanup();
		}
	});

	it("publishes the monitor redirect hint with the correct monitor call shape", async () => {
		const { harness } = await createEvalHarness();
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			expect(harness.agent.removedToolHints.monitor).toContain(MONITOR_HINT);
			expect(harness.agent.removedToolHints.bash).toContain('tool.bash({ command: "..." })');
		} finally {
			harness.cleanup();
		}
	});

	it("keeps getAllTools-backed eval schema access while policy tools stay inactive", async () => {
		const { harness } = await createEvalHarness();
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write"]);
			expect(harness.session.getAllTools().map((tool) => tool.name)).toEqual(
				expect.arrayContaining(["bash", "powershell", "workflow", "monitor"]),
			);
			expect(runEvalSchema({}, { listTools: () => harness.session.getAllTools() })).toEqual({
				tools: expect.arrayContaining(["bash", "powershell"]),
			});
		} finally {
			harness.cleanup();
		}
	});

	it("runs bash through the SDK executeTool wrapper without reactivating it", async () => {
		let api: ExtensionAPI | undefined;
		const extensionFactory: ExtensionFactory = (pi) => {
			api = pi;
			pi.registerTool({
				name: "eval",
				label: "Eval",
				description: "Evaluate code",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
			});
			pi.registerLazyToolActivator((toolName) => {
				pi.setActiveTools([...pi.getActiveTools(), toolName]);
				return true;
			});
		};
		const harness = await createHarness({ extensionFactories: [extensionFactory], evalOnlyToolNames: ["bash"] });
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			if (api === undefined) throw new Error("extension API was not captured");
			const runtime = api;
			const executeTool = createExecuteTool({
				executeTool: (toolName, params, options) => runtime.executeTool(toolName, params, options),
				getActiveTools: () => runtime.getActiveTools(),
				getAllTools: () => runtime.getAllTools(),
			});

			expect(textOf(await executeTool("bash", { command: "echo hi" }))).toContain("hi");
			expect(harness.session.getActiveToolNames()).not.toContain("bash");
		} finally {
			harness.cleanup();
		}
	});

	it("redirects a direct bash call to its eval helper", async () => {
		const { harness } = await createEvalHarness();
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("run bash");
			const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
			expect(toolResult && "content" in toolResult ? toolResult.content[0] : undefined).toMatchObject({
				text: expect.stringContaining('tool.bash({ command: "..." })'),
			});
		} finally {
			harness.cleanup();
		}
	});

	it("keeps all four tools directly available when eval is absent", async () => {
		const { harness } = await createEvalHarness({ withEval: false });
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			for (const name of allPolicyTools) {
				expect(harness.session.getActiveToolNames()).toContain(name);
			}
			for (const name of allPolicyTools) {
				expect(harness.agent.removedToolHints[name]).toBeUndefined();
				expect(harness.session.systemPrompt).not.toContain(`tool.${name}(`);
			}
		} finally {
			harness.cleanup();
		}
	});

	it("honors an SDK evalOnlyToolNames override instead of the default set", async () => {
		const { harness } = await createEvalHarness({ evalOnlyToolNames: ["workflow"] });
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			expect(harness.session.getActiveToolNames()).toContain("bash");
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.session.getActiveToolNames()).toContain("monitor");
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
			expect(harness.session.systemPrompt).not.toContain("tool.bash(");
		} finally {
			harness.cleanup();
		}
	});

	it("remains armed after a settings reload with no policy setting", async () => {
		const { harness } = await createEvalHarness({ fileSettings: true });
		try {
			harness.session.setActiveToolsByName(allRequestedTools);
			await harness.session.reload();

			expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write", "eval"]);
			expect(harness.agent.removedToolHints.monitor).toContain(MONITOR_HINT);
		} finally {
			harness.cleanup();
		}
	});
});

describe("eval-only registry filtering", () => {
	it("does not mention powershell when the registry does not hold it", async () => {
		const { harness } = await createEvalHarness({ excludedToolNames: ["powershell"] });
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			expect(harness.session.getActiveToolNames()).not.toContain("powershell");
			expect(harness.session.systemPrompt).not.toContain("powershell");
			expect(harness.agent.removedToolHints.powershell).toBeUndefined();
			expect(harness.agent.removedToolHints.bash).toContain('tool.bash({ command: "..." })');
		} finally {
			harness.cleanup();
		}
	});
});
