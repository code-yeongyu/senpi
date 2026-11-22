import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 third review M-b: a listed worktree a later T3 Code checkout reused (its own .git) is never
// moved, also for paths past the per-call probe budget; a genuinely moved sibling prefix past the budget is still refused.

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");

describe("moved-path-guard re-used worktree past the call bounds (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function reusedWorktree(cwd: (layout: MovedLayout) => string = (layout) => layout.oldWorktree) {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		vi.stubEnv("HOME", layout.home);
		mkdirSync(join(layout.oldWorktree, "src"), { recursive: true });
		writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
		const harness = await createHarness({
			cwd: cwd(layout),
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { layout, harness };
	}

	it("allows a 70-path git add inside the re-used worktree", async () => {
		const { harness } = await reusedWorktree();
		const files = Array.from({ length: 70 }, (_, index) => `src/f${index}.ts`).join(" ");

		const result = await runTool(harness, "bash", { command: `git add ${files} 2>/dev/null; echo ran` });

		expect(result.outcome).toBe("ok");
	});

	// Fourth review L-g: targets under a listed prefix are probed before ones that are only under a legacy root, so 64+
	// unlisted ~/.t3 paths ahead of a re-used worktree path cannot push it into the text fallback.
	it("allows a re-used worktree path behind 70 unlisted legacy paths", async () => {
		const { layout, harness } = await reusedWorktree((moved) => moved.home);
		const warm = join(layout.oldWorktree, "src", "warm.ts");
		expect(await runTool(harness, "bash", { command: `touch ${warm}` })).toMatchObject({ outcome: "ok" });
		const unlisted = Array.from({ length: 70 }, (_, index) => join(layout.oldRoot, "unlisted", `d${index}`)).join(
			" ",
		);

		const result = await runTool(harness, "bash", {
			command: `ls ${unlisted} ${join(layout.oldWorktree, "src", "z.ts")} 2>/dev/null; echo ran`,
		});

		expect(result.outcome).toBe("ok");
	});

	it("still refuses a genuinely moved sibling prefix that lies past the probe budget", async () => {
		const { layout, harness } = await reusedWorktree();
		const decoys = Array.from({ length: 70 }, (_, index) => join(layout.oldRoot, "unlisted", `d${index}`)).join(" ");

		const result = await runTool(harness, "bash", {
			command: `touch ${decoys} ${join(layout.oldSessions, "late.jsonl")}`,
		});

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newSessions, "late.jsonl"));
	});
});
