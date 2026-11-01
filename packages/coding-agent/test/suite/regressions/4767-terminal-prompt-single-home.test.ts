import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerTerminalExtension from "../../../src/core/extensions/builtin/terminal/index.ts";
import { TerminalManager } from "../../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorRegistry } from "../../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { createMonitorTool, type MonitorInput } from "../../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #4792: substitute fixture values only for fields actually present in each rendered
// signature. Never supply a missing required field on the prompt's behalf.
async function validateMonitorExamples(prompt: string): Promise<void> {
	const values: ToolCall["arguments"] = {
		description: "fixture watch",
		command: "true",
		path: "/fixture/artifact",
		target: "all",
		bash_id: "bash_1",
		filter: "^READY$",
		timeout_ms: 300000,
		persistent: false,
		event: "create",
		events: "all",
		exclude: ["tool_execution_update"],
	};
	const manager = new TerminalManager();
	const registry = new MonitorRegistry(() => {});
	const tool = createMonitorTool({
		manager,
		monitorRegistry: registry,
		cwd: "/fixture",
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => ({}),
	});
	// Stop at the I/O boundary AFTER the tool's own schema and branch validation.
	// No PTY, filesystem watch or RPC host is needed to validate example arguments.
	const accepted = new Error("argument validation reached monitor I/O");
	vi.spyOn(manager, "create").mockRejectedValue(accepted);
	vi.spyOn(registry, "registerFile").mockRejectedValue(accepted);
	vi.spyOn(registry, "registerRpc").mockRejectedValue(accepted);
	vi.spyOn(registry, "rearm").mockReturnValue("rearmed");
	const shapes = [...prompt.matchAll(/(?<![\w.])(?:tool\.)?monitor\(\{([^{}]*)\}\)/g)];
	expect(shapes.length).toBeGreaterThan(0);
	for (const [shape, fields] of shapes) {
		if (fields === undefined) throw new Error("Missing monitor arguments");
		for (const includeOptional of [false, true]) {
			const args: ToolCall["arguments"] = {};
			for (const field of fields.split(",").map((part) => part.trim())) {
				if (field.endsWith("?") && !includeOptional) continue;
				const literal = /^(\w+): "([^"]+)"$/.exec(field);
				const key = literal?.[1] ?? field.replace(/\?$/, "");
				const value = literal?.[2] ?? values[key];
				if (value === undefined) throw new Error(`Unknown monitor example field: ${field}`);
				args[key] = value;
			}
			const input: MonitorInput = validateToolArguments(tool, {
				type: "toolCall",
				id: "prompt-example",
				name: tool.name,
				arguments: args,
			});
			const result = await tool.execute("prompt-example", input).catch((error: unknown) => {
				if (error !== accepted) throw error;
				return { content: [{ text: accepted.message }], isError: false };
			});
			// File registration catches I/O errors; rearm has no I/O.
			expect
				.soft(result.isError === true ? result.content[0]?.text : undefined, shape)
				.toBeOneOf([undefined, accepted.message]);
		}
	}
	registry.dispose();
	await manager.teardown();
}

// #4767: protect the assembled prompt-byte contract, not a prose snapshot.
// Tool metadata and before_agent_start hooks must not both emit the restart recipe.
describe("terminal guidance has one assembled home", () => {
	it.each([
		{ evalOnly: false, nativeBash: false },
		{ evalOnly: true, nativeBash: false },
		{ evalOnly: false, nativeBash: true },
		{ evalOnly: true, nativeBash: true },
	])("emits one restart recipe with $evalOnly eval and $nativeBash native bash", async ({ evalOnly, nativeBash }) => {
		// Given
		vi.stubEnv("PI_ANTHROPIC_BASH", nativeBash ? "1" : "0");
		const extensionFactories: Array<{ factory: ExtensionFactory; path: string }> = [
			{ factory: registerTerminalExtension, path: "<builtin:terminal>" },
		];
		if (evalOnly) {
			extensionFactories.push({
				path: "/fixture/eval.ts",
				factory: (pi) => {
					pi.registerTool({
						name: "eval",
						label: "eval",
						description: "Evaluate code.",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			});
		}
		const harness = await createHarness({
			extensionFactories,
			...(nativeBash
				? { api: "anthropic-messages", provider: "anthropic", models: [{ id: "claude-test", reasoning: false }] }
				: {}),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const build = harness.getExtensionRunner().createContext().getPromptCachePrefixRequest;
		if (!build) throw new Error("Missing prefix builder");

		// When
		const result = await build({ sizesOnly: true });

		// Then
		if (result.status !== "ready") throw new Error(result.reason);
		const prompt = result.request.context.systemPrompt ?? "";
		await validateMonitorExamples(prompt);
		expect(prompt.match(/SENPI_MONITOR_RESTORED=1/g)).toHaveLength(1);
		expect(prompt.match(/^## Persistent terminal sessions$/gm)).toHaveLength(1);
		for (const branch of ["command", "path", 'type: "rpc", target']) {
			const call = `${evalOnly ? "tool.monitor" : "monitor"}({ ${branch.startsWith("type") ? "" : "description, "}${branch}`;
			expect(prompt.split(call)).toHaveLength(2);
		}
		// #4792: run_in_background is a PTY-bash parameter, including prose advice
		// outside a call shape. Native sessions must route long work through monitor.
		const terminalSection = prompt.slice(prompt.indexOf("## Persistent terminal sessions"));
		if (nativeBash) expect.soft(terminalSection).not.toContain("run_in_background");
		else expect(prompt).toMatch(/(?:tool\.)?bash\(\{ command, run_in_background:/);
	});
});
