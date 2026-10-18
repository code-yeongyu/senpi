import { describe, expect, it, vi } from "vitest";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalRuntimes } from "../src/tool/types.ts";
import { FakeManager } from "./eval/fakes.ts";

const bunSkillPath = "/opt/senpi/skill/bun-1-4/SKILL.md";

function evalDescription(options: { readonly runtimes?: EvalRuntimes; readonly bunSkillPath?: string }): string {
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
		...options,
	}).description;
}

describe("createEvalTool prompt runtime line", () => {
	it("points at the active bun-1-4 skill for installs, servers and long runs on a bun kernel", () => {
		const description = evalDescription({
			runtimes: { js: { name: "bun", version: "1.4.0", path: "/usr/local/bin/bun" } },
			bunSkillPath,
		});

		expect(description).toContain("JS runs in-process on Bun 1.4.0");
		expect(description).toContain(
			`Before a cell that installs a package, spawns a server or PTY, or starts a long run, read the bun-1-4 skill at ${bunSkillPath}`,
		);
		expect(description).not.toContain("before your first js cell");
	});

	it("keeps the Bun line without a pointer when no skill is active", () => {
		const description = evalDescription({ runtimes: { js: { name: "bun", version: "1.4.0" } } });

		expect(description).toContain("JS runs in-process on Bun 1.4.0");
		expect(description).not.toContain("bun-1-4 skill");
	});

	it("keeps the Node.js wording on a node kernel even when a skill path is supplied", () => {
		const description = evalDescription({
			runtimes: { js: { name: "node", version: "26.7.0", path: "/usr/local/bin/node" } },
			bunSkillPath,
		});

		expect(description).toContain("Node.js worker");
		expect(description).not.toContain(bunSkillPath);
	});
});
