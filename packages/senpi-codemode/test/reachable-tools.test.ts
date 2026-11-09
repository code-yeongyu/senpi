import { describe, expect, it } from "vitest";
import { createExecuteTool } from "../src/extension/runtime-factory.ts";
import { activeKernelPreludes } from "../src/extension/kernel-preludes.ts";
import { reachableToolNames } from "../src/extension/reachable-tools.ts";

const prelude = {
	javascript: "globalThis.spawnHelper = 1;",
	python: "spawn_helper = 1",
	documentation: "spawnHelper",
	exports: ["spawnHelper"],
};

function registry(
	active: readonly string[],
	all: ReadonlyArray<{ name: string; exposure?: string; kernelPrelude?: typeof prelude }>,
) {
	return {
		getActiveTools: () => [...active],
		getAllTools: () => all,
		executeTool: async () => {
			throw new Error("not called");
		},
	};
}

describe("eval-exposed tools stay reachable from a cell", () => {
	it("counts a registered eval-exposed tool the session withholds from the model", () => {
		const pi = registry(
			["read", "eval"],
			[
				{ name: "read" },
				{ name: "eval" },
				{ name: "task", exposure: "eval" },
				{ name: "x_search", exposure: "search" },
			],
		);
		expect([...reachableToolNames(pi)].sort()).toEqual(["eval", "read", "task"]);
	});

	it("reports an eval-exposed task tool available to agent()/output()", () => {
		const pi = registry(
			["read", "eval"],
			[
				{ name: "task", exposure: "eval" },
				{ name: "task_output", exposure: "eval" },
			],
		);
		const executeTool = createExecuteTool(pi);
		expect(executeTool.isToolAvailable?.("task")).toBe(true);
		expect(executeTool.isToolAvailable?.("task_output")).toBe(true);
		expect(executeTool.isToolAvailable?.("task_cancel")).toBe(false);
	});

	it("keeps the kernel prelude of an eval-exposed tool while it is withheld", () => {
		const pi = registry(
			["eval"],
			[
				{ name: "task", exposure: "eval", kernelPrelude: prelude },
				{ name: "other", exposure: "search", kernelPrelude: prelude },
			],
		);
		expect(activeKernelPreludes(pi)).toEqual([prelude]);
	});
});
