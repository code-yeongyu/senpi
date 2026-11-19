import { describe, expect, it, vi } from "vitest";
import { runEvalSchema } from "../src/bridges/schema-bridge.ts";
import { evalOnlyToolNames } from "../src/extension/reachable-tools.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeManager } from "./eval/fakes.ts";

// senpi#6886: a host may replace the whole system prompt, so the eval description is the one place a model always
// reads which withheld tools a cell can call; and tool_schema()'s documented shape must be the one it returns.

// Claude Code keeps only the first 4096 chars of an MCP tool description (oh-my-openagent#14291), which is how the
// eval tool reaches the model on the Claude subscription lane.
const CLAUDE_CODE_MCP_DESCRIPTION_CAP = 4096;

function evalDescription(evalOnlyTools?: readonly string[], everyLanguage = false): string {
	return createEvalTool({
		enabledLanguages: { js: true, py: everyLanguage, rb: everyLanguage, jl: everyLanguage },
		...(everyLanguage ? { spawns: true, monitor: true, hostLine: "linux x64 · 16 cores" } : {}),
		kernelManager: new FakeManager([]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
		...(evalOnlyTools === undefined ? {} : { evalOnlyTools }),
	}).description;
}

describe("eval description names the session's eval-only tools", () => {
	it("lists every eval-only tool the session routes through eval", () => {
		const description = evalDescription(["bash", "generate_image", "thread_list", "workflow"]);
		const line = description.split("\n").find((entry) => entry.includes("Eval-only tools"));

		expect(line).toBeDefined();
		for (const name of ["bash", "generate_image", "thread_list", "workflow"]) expect(line).toContain(name);
	});

	it("names the eval-only tools within Claude Code's MCP description cap even when the description is longer", () => {
		const names = ["bash", "monitor", "thread_create", "thread_list", "thread_read", "thread_send", "workflow"];
		const description = evalDescription(names, true);

		expect(description.length).toBeGreaterThan(CLAUDE_CODE_MCP_DESCRIPTION_CAP);
		const kept = description.slice(0, CLAUDE_CODE_MCP_DESCRIPTION_CAP);
		const line = kept.split("\n").find((entry) => entry.includes("Eval-only tools"));
		expect(line).toBeDefined();
		for (const name of names) expect(line).toContain(name);
	});

	it("adds no eval-only line when the session withholds nothing", () => {
		expect(evalDescription([])).not.toContain("Eval-only tools");
		expect(evalDescription()).not.toContain("Eval-only tools");
	});

	it("reads the eval-only set from the session's tool registry", () => {
		const pi = {
			getActiveTools: () => ["read", "eval"],
			getAllTools: () => [
				{ name: "read" },
				{ name: "eval" },
				{ name: "thread_list", exposure: "eval", evalOnly: true },
				{ name: "workflow", exposure: "direct", evalOnly: true },
				{ name: "x_search", exposure: "search" },
			],
		};
		expect(evalOnlyToolNames(pi)).toEqual(["thread_list", "workflow"]);
	});
});

describe("tool_schema() documentation", () => {
	it("documents the key the no-argument call actually returns", () => {
		const listed = runEvalSchema({}, { listTools: () => [{ name: "read" }] });
		const [key] = Object.keys(listed);

		expect(evalDescription()).toContain(`{ ${key}: [`);
	});
});
