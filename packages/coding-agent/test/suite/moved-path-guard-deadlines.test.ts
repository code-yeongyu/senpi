import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { flushGuardLog, guardLogPath } from "../../src/core/extensions/builtin/moved-path-guard/guard-log.ts";
import { STEP_DEADLINE_MS } from "../../src/core/extensions/builtin/moved-path-guard/resolve-async.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 third review M-a: a path whose own lookup times out is not silently "not moved". A path
// spelled with SLOW never finishes canonicalizing here, standing in for a wedged mount; the guard's own deadline,
// not filesystem speed, decides when it gives up.

const slowStarts = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/core/tools/filesystem-policy.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/tools/filesystem-policy.ts")>();
	return {
		...actual,
		canonicalizeFilesystemPath: (path: string) => {
			if (!path.includes("SLOW")) return actual.canonicalizeFilesystemPath(path);
			slowStarts.count++;
			return new Promise<string>(() => {});
		},
	};
});

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");

async function guardLogEvents(): Promise<Array<Record<string, unknown>>> {
	await flushGuardLog();
	const text = await readFile(guardLogPath(), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("moved-path-guard step deadline (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function setup() {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { layout, harness };
	}

	it("refuses a moved path whose own lookup times out, and logs the step bound", async () => {
		const { layout, harness } = await setup();

		const result = await runTool(harness, "bash", { command: `touch ${layout.oldWorktree}/SLOWdir/a.txt` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "SLOWdir", "a.txt"));
		expect(await guardLogEvents()).toContainEqual(
			expect.objectContaining({ event: "call_bound_reached", bound: "step" }),
		);
	});

	// Third review M-b: past the call deadline, a re-used worktree the probe already cleared is not refused by text.
	it("allows a re-used worktree's paths past the call deadline", async () => {
		const { layout, harness } = await setup();
		vi.stubEnv("HOME", layout.home);
		mkdirSync(join(layout.oldWorktree, "src"), { recursive: true });
		writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
		const slow = Array.from({ length: 6 }, (_, index) => join(layout.oldRoot, "other", `SLOW${index}`)).join(" ");
		const files = Array.from({ length: 5 }, (_, index) => join(layout.oldWorktree, "src", `f${index}.ts`)).join(" ");

		const result = await runTool(harness, "bash", { command: `cd ${layout.oldWorktree} && touch ${slow} ${files}` });

		expect(result.outcome).toBe("ok");
		expect(await guardLogEvents()).toContainEqual(
			expect.objectContaining({ event: "call_bound_reached", bound: "deadline" }),
		);
	});

	// Third review L-c: once the call deadline passes, the probe loop starts no further filesystem work.
	it("starts no filesystem step after the call deadline", async () => {
		const { layout, harness } = await setup();
		const slow = Array.from({ length: 20 }, (_, index) => join(layout.home, "elsewhere", `SLOW${index}`)).join(" ");

		expect(await runTool(harness, "bash", { command: `touch ${slow}` })).toMatchObject({ outcome: "ok" });
		const startedByDeadline = slowStarts.count;
		// Time is the behavior here: a loop still running would start its next step within one step deadline.
		await new Promise((resolve) => setTimeout(resolve, STEP_DEADLINE_MS + 200));

		expect(slowStarts.count).toBe(startedByDeadline);
	});

	// The re-used decision holds whatever spelling names the worktree, even after a timed-out lookup made the guard
	// remember the breadcrumb under a non-canonical spelling (a symlinked home, macOS /var vs /private/var).
	it("allows a re-used worktree named through another spelling of the home", async () => {
		const { layout, harness } = await setup();
		mkdirSync(join(layout.oldWorktree, "src"), { recursive: true });
		writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
		const alias = `${layout.home}-alias`;
		symlinkSync(layout.home, alias);
		const aliasRoot = join(alias, ".t3");
		try {
			const slow = await runTool(harness, "bash", {
				command: `touch ${join(aliasRoot, "userdata", "omo-sessions", "SLOW")}`,
			});
			const files = Array.from({ length: 70 }, (_, index) =>
				join(aliasRoot, "worktrees", "app", "w1", `f${index}.ts`),
			);
			const reused = await runTool(harness, "bash", { command: `touch ${files.join(" ")}` });

			expect(slow.outcome).toBe("blocked");
			expect(reused.outcome).toBe("ok");
		} finally {
			rmSync(alias, { force: true });
		}
	});

	it("still allows an unrelated path whose lookup times out", async () => {
		const { layout, harness } = await setup();

		const result = await runTool(harness, "bash", { command: `touch ${layout.home}/elsewhere/SLOW/a.txt; echo ran` });

		expect(result.outcome).toBe("ok");
	});
});
