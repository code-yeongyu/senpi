import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

const WORKFLOW_HINT = 'tool.workflow({ action: "..." })';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function armedNames(harness: Harness): string[] {
	const session = harness.session as unknown as { _evalOnlyToolNames?: ReadonlySet<string> };
	return [...(session._evalOnlyToolNames ?? [])];
}

/** Arm the policy directly, standing in for an SDK embedder's evalOnlyToolNames override. */
function arm(harness: Harness, names: string[]): void {
	const session = harness.session as unknown as { _evalOnlyToolNames: ReadonlySet<string> };
	session._evalOnlyToolNames = new Set(names);
}

interface WorkflowHarnessOptions {
	withEval?: boolean;
	settings?: Record<string, unknown>;
}

async function createWorkflowHarness(options: WorkflowHarnessOptions = {}): Promise<{
	harness: Harness;
	observed: string[];
}> {
	const observed: string[] = [];
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
		// Stands in for the external extension that registers the real workflow tool.
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
		pi.on("tool_call", (event) => {
			if (event.toolName === "workflow") observed.push(event.toolName);
		});
	};
	const harness = await createHarness({
		extensionFactories: [extensionFactory],
		...(options.settings ? { settings: options.settings } : {}),
	});
	return { harness, observed };
}

describe("experimental workflow eval-only policy", () => {
	it("hides workflow and explains tool.workflow( when the flag arms the session", async () => {
		// Given: a session whose settings enable experimental.workflowEvalOnly with eval registered
		const { harness } = await createWorkflowHarness({ settings: { experimental: { workflowEvalOnly: true } } });
		try {
			// When: the caller requests workflow among its active tools
			harness.session.setActiveToolsByName(["read", "workflow", "edit", "write"]);

			// Then: workflow is withheld and the prompt names its eval helper
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.session.systemPrompt).toContain("tool.workflow({ action:");
		} finally {
			harness.cleanup();
		}
	});

	it("executes hidden workflow through hooks without reactivating it", async () => {
		// Given: an armed session with workflow left out of the active set
		const { harness, observed } = await createWorkflowHarness({
			settings: { experimental: { workflowEvalOnly: true } },
		});
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			// When: the eval bridge executes workflow directly
			const result = await harness.session.executeTool(
				"workflow",
				{ action: "deploy" },
				{ activateInactiveTool: true },
			);

			// Then: it runs through the registry, emits a tool_call, and stays inactive
			expect(textOf(result)).toContain("workflow-ran:deploy");
			expect(observed).toEqual(["workflow"]);
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
		} finally {
			harness.cleanup();
		}
	});

	it("publishes the workflow removed-tool hint for direct model calls", async () => {
		// Given: an armed session with workflow withheld
		const { harness } = await createWorkflowHarness({ settings: { experimental: { workflowEvalOnly: true } } });
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("workflow", { action: "deploy" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			// When: the model calls workflow directly anyway
			await harness.session.prompt("run workflow");

			// Then: the tool result redirects it to the eval helper
			const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
			expect(toolResult && "content" in toolResult ? toolResult.content[0] : undefined).toMatchObject({
				text: expect.stringContaining(WORKFLOW_HINT),
			});
		} finally {
			harness.cleanup();
		}
	});

	it("leaves the policy inert when eval is not registered", async () => {
		// Given: the flag is on but no eval tool exists to route through
		const { harness } = await createWorkflowHarness({
			withEval: false,
			settings: { experimental: { workflowEvalOnly: true } },
		});
		try {
			// When: workflow is requested as an active tool
			harness.session.setActiveToolsByName(["read", "workflow", "edit", "write"]);

			// Then: workflow stays directly available
			expect(harness.session.getActiveToolNames()).toContain("workflow");
			expect(textOf(await harness.session.executeTool("workflow", { action: "deploy" }))).toContain(
				"workflow-ran:deploy",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps flag-off behavior unchanged", async () => {
		// Given: a session with no experimental flags
		const { harness } = await createWorkflowHarness();
		try {
			const before = harness.session.systemPrompt;

			// When: workflow is requested as an active tool
			harness.session.setActiveToolsByName(["read", "workflow", "edit", "write"]);

			// Then: nothing is withheld and no eval guidance is appended
			expect(harness.session.getActiveToolNames()).toEqual(["read", "workflow", "edit", "write"]);
			expect(harness.session.systemPrompt).not.toContain("tool.workflow(");
			expect(before).not.toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});

	it("arms only workflow when bashEvalOnly stays off", async () => {
		// Given: only the workflow flag is enabled
		const { harness } = await createWorkflowHarness({ settings: { experimental: { workflowEvalOnly: true } } });
		try {
			// When: shell tools and workflow are all requested
			harness.session.setActiveToolsByName(["read", "bash", "powershell", "workflow", "edit"]);

			// Then: shell tools stay directly available and no shell sentence is appended
			expect(armedNames(harness)).toEqual(["workflow"]);
			expect(harness.session.getActiveToolNames()).toContain("bash");
			expect(harness.session.getActiveToolNames()).toContain("powershell");
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.session.systemPrompt).not.toContain("tool.bash(");
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});

	it("arms the union of both groups when both experimental flags are on", async () => {
		// Given: both experimental eval-only flags are enabled
		const { harness } = await createWorkflowHarness({
			settings: { experimental: { bashEvalOnly: true, workflowEvalOnly: true } },
		});
		try {
			// When: shell tools and workflow are all requested
			harness.session.setActiveToolsByName(["read", "bash", "powershell", "workflow", "edit"]);

			// Then: every group member is withheld and each hint names its own helper
			expect(new Set(armedNames(harness))).toEqual(new Set(["bash", "powershell", "workflow"]));
			const active = harness.session.getActiveToolNames();
			expect(active).toEqual(["read", "edit"]);
			expect(harness.agent.removedToolHints.bash).toContain('tool.bash({ command: "..." })');
			expect(harness.agent.removedToolHints.powershell).toContain('tool.powershell({ command: "..." })');
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			expect(harness.session.systemPrompt).toContain("tool.bash(");
			expect(harness.session.systemPrompt).toContain("tool.powershell(");
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});

	it("explains eval-only names an SDK override armed outside the built-in groups", async () => {
		// Given: an embedder arms a custom tool name that is neither a shell tool nor workflow
		const { harness } = await createWorkflowHarness();
		try {
			arm(harness, ["custom"]);

			// When: the active tool set is rebuilt under that policy
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			// Then: the prompt still names the generic eval helper for that tool
			expect(harness.session.systemPrompt).toContain(
				"These tools run ONLY inside eval cells via tool.custom({ ... }); hooks and permissions still apply.",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the shell and workflow sentences when a custom override name is armed alongside them", async () => {
		// Given: an override arming a shell tool, workflow, and a custom name at once
		const { harness } = await createWorkflowHarness();
		try {
			arm(harness, ["bash", "workflow", "custom"]);

			// When: the active tool set is rebuilt under that policy
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			// Then: all three sentences are present, with the built-in wording unchanged
			const prompt = harness.session.systemPrompt;
			expect(prompt).toContain(
				'Shell commands run ONLY inside eval cells via tool.bash({ command: "..." }); hooks and permissions still apply.',
			);
			expect(prompt).toContain(
				'The workflow tool runs ONLY inside eval cells via tool.workflow({ action: "..." }); hooks and permissions still apply.',
			);
			expect(prompt).toContain(
				"These tools run ONLY inside eval cells via tool.custom({ ... }); hooks and permissions still apply.",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("drops hints for names that leave the armed set when the policy shrinks", async () => {
		// Given: a session armed for both shell tools and workflow
		const { harness } = await createWorkflowHarness();
		try {
			arm(harness, ["bash", "powershell", "workflow"]);
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			expect(harness.agent.removedToolHints.bash).toBeDefined();

			// When: the armed set shrinks to workflow only
			arm(harness, ["workflow"]);
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			// Then: the shell hints are withdrawn while workflow keeps its hint
			expect(harness.agent.removedToolHints.bash).toBeUndefined();
			expect(harness.agent.removedToolHints.powershell).toBeUndefined();
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
		} finally {
			harness.cleanup();
		}
	});

	it("leaves hints published by other owners untouched when the policy disarms", async () => {
		// Given: an armed session plus an unrelated hint published by someone else
		const { harness } = await createWorkflowHarness();
		try {
			arm(harness, ["workflow"]);
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			harness.agent.removedToolHints.somethingElse = "owned by another publisher";

			// When: the policy disarms
			(harness.session as unknown as { _evalOnlyToolNames?: ReadonlySet<string> })._evalOnlyToolNames = undefined;
			harness.session.setActiveToolsByName(["read", "workflow", "edit", "write"]);

			// Then: only the policy's own hint is removed
			expect(harness.agent.removedToolHints.workflow).toBeUndefined();
			expect(harness.agent.removedToolHints.somethingElse).toBe("owned by another publisher");
		} finally {
			harness.cleanup();
		}
	});
});

describe("experimental workflow eval-only policy across reload", () => {
	async function createReloadHarness(options: {
		flagOn?: boolean;
		settings?: Record<string, unknown>;
	}): Promise<Harness> {
		const extensionFactory: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "eval",
				label: "Eval",
				description: "Evaluate code",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
			});
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
		};
		const settings = options.settings ?? (options.flagOn ? { experimental: { workflowEvalOnly: true } } : undefined);
		return await createHarness({
			fileSettings: true,
			...(settings ? { settings } : {}),
			initialActiveToolNames: ["read", "bash", "powershell", "workflow", "edit"],
			extensionFactories: [extensionFactory],
		});
	}

	function writeSettings(harness: Harness, contents: Record<string, unknown>): void {
		writeFileSync(join(harness.tempDir, "agent", "settings.json"), JSON.stringify(contents));
	}

	it("arms the policy when the workflow flag is turned on and the session reloads", async () => {
		// Given: a session started with the flag off, so workflow is directly available
		const harness = await createReloadHarness({ flagOn: false });
		try {
			expect(harness.session.getActiveToolNames()).toContain("workflow");

			// When: the flag is turned on and the session reloads
			writeSettings(harness, { experimental: { workflowEvalOnly: true } });
			await harness.session.reload();

			// Then: workflow is withheld and the eval guidance is appended
			expect(armedNames(harness)).toEqual(["workflow"]);
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});

	it("disarms and clears the workflow hint when the flag is turned off and the session reloads", async () => {
		// Given: an armed session that has already published the workflow hint
		const harness = await createReloadHarness({ flagOn: true });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);

			// When: the flag is removed and the session reloads
			writeSettings(harness, {});
			await harness.session.reload();

			// Then: workflow comes back and its stale redirect hint is withdrawn
			expect(harness.session.getActiveToolNames()).toContain("workflow");
			expect(harness.agent.removedToolHints.workflow).toBeUndefined();
			expect(harness.session.systemPrompt).not.toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps shell tools armed when only the workflow flag is turned off across a reload", async () => {
		// Given: a session armed for the union of both groups
		const harness = await createReloadHarness({
			settings: { experimental: { bashEvalOnly: true, workflowEvalOnly: true } },
		});
		try {
			expect(new Set(armedNames(harness))).toEqual(new Set(["bash", "powershell", "workflow"]));
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);

			// When: only the workflow flag is turned off and the session reloads
			writeSettings(harness, { experimental: { bashEvalOnly: true } });
			await harness.session.reload();

			// Then: shell tools stay withheld while workflow returns without a stale hint
			expect(new Set(armedNames(harness))).toEqual(new Set(["bash", "powershell"]));
			const active = harness.session.getActiveToolNames();
			expect(active).toContain("workflow");
			expect(active).not.toContain("bash");
			expect(harness.agent.removedToolHints.workflow).toBeUndefined();
			expect(harness.agent.removedToolHints.bash).toBeDefined();
		} finally {
			harness.cleanup();
		}
	});

	it("retains the withheld workflow tool across a reload so a later disarm restores it", async () => {
		// Given: an armed session whose workflow request is already filtered out
		const harness = await createReloadHarness({ flagOn: true });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");

			// When: the session reloads while still armed
			await harness.session.reload();

			// Then: workflow stays hidden but the unfiltered request still carries it
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			const retained = (harness.session as unknown as { _requestedActiveToolNames?: string[] })
				._requestedActiveToolNames;
			expect(retained).toContain("workflow");

			// And: a later disarm restores it
			writeSettings(harness, {});
			await harness.session.reload();
			expect(harness.session.getActiveToolNames()).toContain("workflow");
		} finally {
			harness.cleanup();
		}
	});
});
