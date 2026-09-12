import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createHarness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

const WORKFLOW_HINT = 'tool.workflow({ action: "..." })';
const MONITOR_HINT = 'tool.monitor({ description: "...", command: "...", filter: "..." })';
const allPolicyTools = ["bash", "powershell", "workflow", "monitor"];
const allRequestedTools = ["read", ...allPolicyTools, "edit", "write"];

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

interface WorkflowHarnessOptions {
	withEval?: boolean;
	excludedToolNames?: string[];
	evalOnlyToolNames?: string[];
	fileSettings?: boolean;
}

async function createWorkflowHarness(options: WorkflowHarnessOptions = {}) {
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
		pi.registerTool({
			name: "custom",
			label: "Custom",
			description: "Run a custom action",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `custom-ran:${params.value}` }],
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

describe("default eval-only workflow policy", () => {
	it("hides workflow by default and keeps the three prompt sentence groups", async () => {
		const { harness } = await createWorkflowHarness();
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write"]);
			expect(harness.session.systemPrompt).toContain(
				'Shell commands run ONLY inside eval cells via tool.bash({ command: "..." }) or tool.powershell({ command: "..." })',
			);
			expect(harness.session.systemPrompt).toContain(
				'The workflow tool runs ONLY inside eval cells via tool.workflow({ action: "..." })',
			);
			expect(harness.session.systemPrompt).toContain(`These tools run ONLY inside eval cells via ${MONITOR_HINT}`);
		} finally {
			harness.cleanup();
		}
	});

	it("executes hidden workflow through hooks without reactivating it", async () => {
		const { harness } = await createWorkflowHarness();
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			const result = await harness.session.executeTool(
				"workflow",
				{ action: "deploy" },
				{ activateInactiveTool: true },
			);

			expect(textOf(result)).toContain("workflow-ran:deploy");
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
		} finally {
			harness.cleanup();
		}
	});

	it("executes hidden monitor with its required description and command fields", async () => {
		const { harness } = await createWorkflowHarness();
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			const result = await harness.session.executeTool(
				"monitor",
				{ description: "watch deploy", command: "printf READY", filter: "^READY$" },
				{ activateInactiveTool: true },
			);

			expect(textOf(result)).toContain("monitor-ran:watch deploy:printf READY:^READY$");
			expect(harness.session.getActiveToolNames()).not.toContain("monitor");
		} finally {
			harness.cleanup();
		}
	});

	it("publishes workflow and monitor redirect hints", async () => {
		const { harness } = await createWorkflowHarness();
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			expect(harness.agent.removedToolHints.monitor).toContain(MONITOR_HINT);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps all four tools directly available when eval is absent", async () => {
		const { harness } = await createWorkflowHarness({ withEval: false });
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			for (const name of allPolicyTools) {
				expect(harness.session.getActiveToolNames()).toContain(name);
			}
			expect(harness.agent.removedToolHints.workflow).toBeUndefined();
			expect(harness.agent.removedToolHints.monitor).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("honors an SDK override for a custom eval-only tool", async () => {
		const { harness } = await createWorkflowHarness({ evalOnlyToolNames: ["custom"] });
		try {
			harness.session.setActiveToolsByName(["read", "custom", "edit", "write"]);

			expect(harness.session.getActiveToolNames()).not.toContain("custom");
			expect(harness.agent.removedToolHints.custom).toContain("tool.custom({ ... })");
			expect(harness.session.systemPrompt).toContain(
				"These tools run ONLY inside eval cells via tool.custom({ ... }); hooks and permissions still apply.",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps shell, workflow, and other guidance groups for an SDK override", async () => {
		const { harness } = await createWorkflowHarness({ evalOnlyToolNames: ["bash", "workflow", "custom"] });
		try {
			harness.session.setActiveToolsByName(["read", "bash", "workflow", "custom", "edit"]);

			expect(harness.session.getActiveToolNames()).toEqual(["read", "edit"]);
			expect(harness.session.systemPrompt).toContain('tool.bash({ command: "..." })');
			expect(harness.session.systemPrompt).toContain(WORKFLOW_HINT);
			expect(harness.session.systemPrompt).toContain("tool.custom({ ... })");
		} finally {
			harness.cleanup();
		}
	});

	it("remains armed after a settings reload with no policy setting", async () => {
		const { harness } = await createWorkflowHarness({ fileSettings: true });
		try {
			harness.session.setActiveToolsByName(allRequestedTools);
			await harness.session.reload();

			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});
});

describe("eval-only registry filtering", () => {
	it("does not mention powershell in prompt or hints when the registry lacks it", async () => {
		const { harness } = await createWorkflowHarness({ excludedToolNames: ["powershell"] });
		try {
			harness.session.setActiveToolsByName(allRequestedTools);

			expect(harness.session.getActiveToolNames()).not.toContain("powershell");
			expect(harness.session.systemPrompt).not.toContain("powershell");
			expect(harness.agent.removedToolHints.powershell).toBeUndefined();
			expect(harness.session.systemPrompt).toContain("tool.bash(");
			expect(harness.session.systemPrompt).toContain("tool.monitor(");
		} finally {
			harness.cleanup();
		}
	});
});
