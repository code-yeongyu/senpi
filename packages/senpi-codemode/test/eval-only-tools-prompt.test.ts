import { describe, expect, it, vi } from "vitest";
import { runEvalSchema } from "../src/bridges/schema-bridge.ts";
import { evalOnlyToolNames } from "../src/extension/reachable-tools.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeManager } from "./eval/fakes.ts";

// senpi#6886: a host may replace the whole system prompt, so the eval description is the one place a model always
// reads which withheld tools a cell can call; and tool_schema()'s documented shape must be the one it returns.

function evalDescription(evalOnlyTools?: readonly string[]): string {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
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
