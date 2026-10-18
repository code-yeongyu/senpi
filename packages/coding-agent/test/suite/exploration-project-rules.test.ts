import { describe, expect, it } from "vitest";
import { registerRuleActivationRenderer } from "../../src/core/extensions/builtin/rule-activation/index.ts";
import { explorationSurface, runTool } from "./exploration-surface-harness.ts";

// senpi#2057: a project-rules notice for a read inside an exploration group folds into that group.
function projectRules(toolCallId: string | undefined, rules: string[]) {
	return {
		type: "custom" as const,
		id: `rules-${toolCallId ?? "legacy"}-${rules.join("+")}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "rule-activation",
		data: { kind: "project-rules", targetPath: "src/a.ts", rules, ...(toolCallId ? { toolCallId } : {}) },
	};
}

async function surfaceWith(notices: Array<ReturnType<typeof projectRules>>, afterIndex: number[]) {
	const surface = await explorationSurface(true, [registerRuleActivationRenderer]);
	const reads = ["src/a.ts", "src/b.ts", "src/c.ts"];
	for (const [index, path] of reads.entries()) {
		await runTool(surface, { id: `read-${index}`, toolName: "read", args: { path } });
		for (const [n, at] of afterIndex.entries()) {
			if (at === index) await surface.event({ type: "entry_appended", entry: notices[n] } as never);
		}
	}
	return surface;
}

describe("project rules inside an exploration group", () => {
	it("folds matching notices into one Explored cell with an English rules line", async () => {
		const surface = await surfaceWith(
			[projectRules("read-0", ["AGENTS.md"]), projectRules("read-1", ["AGENTS.md", "src/AGENTS.md"])],
			[0, 1],
		);
		try {
			const text = surface.text();
			expect(text.match(/Explored/g)).toHaveLength(1);
			expect(text).toContain("Read a.ts, b.ts, c.ts");
			expect(text).toContain("Applied 2 project rules");
			expect(text).not.toContain("Project rules ·");
		} finally {
			surface.cleanup();
		}
	});

	it.each([
		["a legacy notice without a tool call id", projectRules(undefined, ["AGENTS.md"])],
		["a notice for a call outside the group", projectRules("read-99", ["AGENTS.md"])],
	])("keeps %s as its own card", async (_, notice) => {
		const surface = await surfaceWith([notice], [0]);
		try {
			const text = surface.text();
			expect(text).toContain("Project rules · src/a.ts");
			expect(text).not.toContain("Applied");
		} finally {
			surface.cleanup();
		}
	});
});
