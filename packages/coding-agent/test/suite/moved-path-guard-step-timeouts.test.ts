import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { pathExists } from "../../src/core/extensions/builtin/moved-path-guard/resolve-async.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 fourth review M-d: when a breadcrumb read or a .git check times out, the guard decides the
// way its text fallback does: a moved prefix trusted earlier is still refused, and a worktree the probe found re-used
// is still allowed. The slow steps never settle, so the guard's own deadlines decide.

const stall = vi.hoisted(() => ({ breadcrumb: "", git: false, gitError: "" }));

vi.mock("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts")>();
	return {
		...actual,
		readJsonFileAsync: (file: string) =>
			file === stall.breadcrumb ? new Promise<unknown>(() => {}) : actual.readJsonFileAsync(file),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		access: (path: string, mode?: number) => {
			if (!String(path).endsWith(".git")) return actual.access(path, mode);
			if (stall.git) return new Promise<void>(() => {});
			if (stall.gitError) return Promise.reject(Object.assign(new Error(stall.gitError), { code: stall.gitError }));
			return actual.access(path, mode);
		},
	};
});

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");

describe("moved-path-guard step timeouts on breadcrumb and .git (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		stall.breadcrumb = "";
		stall.git = false;
		stall.gitError = "";
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function setup(cwd?: (layout: MovedLayout) => string) {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		const harness = await createHarness({
			cwd: cwd?.(layout) ?? layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { layout, harness };
	}

	it("refuses a trusted moved path whose breadcrumb read times out", async () => {
		const { layout, harness } = await setup();
		expect(await runTool(harness, "bash", { command: `touch ${layout.oldWorktree}/a` })).toMatchObject({
			outcome: "blocked",
		});
		// Only the old root's breadcrumb is slow, so the call stays well inside its own deadline.
		stall.breadcrumb = join(layout.oldRoot, "omo-desktop-moved.json");

		const result = await runTool(harness, "bash", { command: `touch ${layout.oldWorktree}/b` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "b"));
	});

	it("allows a re-used worktree whose .git check times out", async () => {
		const { harness } = await setup((moved) => {
			mkdirSync(join(moved.oldWorktree, "src"), { recursive: true });
			writeFileSync(join(moved.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
			return moved.oldWorktree;
		});
		expect(await runTool(harness, "bash", { command: "touch src/a.ts" })).toMatchObject({ outcome: "ok" });
		stall.git = true;

		const result = await runTool(harness, "bash", { command: "touch src/b.ts" });

		expect(result.outcome).toBe("ok");
	});

	// Fifth review M-1: a timed-out breadcrumb read never reaches the .git step, so the text fallback itself must honour
	// the re-used decision this process already holds for the prefix.
	it("allows a re-used worktree whose breadcrumb read times out after it was found re-used", async () => {
		const { layout, harness } = await reusedWorktreeSetup();
		expect(await runTool(harness, "bash", { command: "touch src/a.ts" })).toMatchObject({ outcome: "ok" });
		stall.breadcrumb = join(layout.oldRoot, "omo-desktop-moved.json");

		const result = await runTool(harness, "bash", { command: "touch src/b.ts" });

		expect(result.outcome).toBe("ok");
	});

	// Fifth review nit: only a real absence (ENOENT, ENOTDIR) is "not re-used"; any other access error is unknown and
	// keeps the remembered answer instead of overwriting it.
	it("allows a re-used worktree whose .git check fails with EACCES after it was found re-used", async () => {
		const { harness } = await reusedWorktreeSetup();
		expect(await runTool(harness, "bash", { command: "touch src/a.ts" })).toMatchObject({ outcome: "ok" });
		stall.gitError = "EACCES";

		const result = await runTool(harness, "bash", { command: "touch src/b.ts" });

		expect(result.outcome).toBe("ok");
	});

	it("reports a missing path as absent and any other access error as unknown", async () => {
		const { layout } = await setup();
		stall.gitError = "EACCES";

		expect(await pathExists(join(layout.oldRoot, "nope", ".git"))).toBeUndefined();
		stall.gitError = "";
		expect(await pathExists(join(layout.oldRoot, "nope", ".git"))).toBe(false);
		expect(await pathExists(join(layout.oldRoot, "omo-desktop-moved.json", ".git"))).toBe(false);
	});

	function reusedWorktreeSetup() {
		return setup((moved) => {
			mkdirSync(join(moved.oldWorktree, "src"), { recursive: true });
			writeFileSync(join(moved.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
			return moved.oldWorktree;
		});
	}
});
