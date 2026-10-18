import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, MOVED_WORKTREE, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 fifth review M-2, sixth review MEDIUM-1: a trusted breadcrumb's old root is walked in its
// realpath spelling while commands name `~/.t3/...`. When `$HOME` or `~/.t3` itself is a symlink those differ, and the
// text fallback and the probe ranking must match both, or a moved target past the probe budget or after a step timeout
// is allowed. Node's `os.homedir()` follows a runtime $HOME change (Bun's does not), so these run under vitest/node.

const stall = vi.hoisted(() => ({ breadcrumb: "" }));

// A path spelled with SLOW never finishes canonicalizing, standing in for a wedged mount (seventh review LOW-B).
vi.mock("../../src/core/tools/filesystem-policy.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/tools/filesystem-policy.ts")>();
	return {
		...actual,
		canonicalizeFilesystemPath: (path: string) =>
			path.includes("SLOW") ? new Promise<string>(() => {}) : actual.canonicalizeFilesystemPath(path),
	};
});

vi.mock("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts")>();
	return {
		...actual,
		readJsonFileAsync: (file: string) =>
			file === stall.breadcrumb ? new Promise<unknown>(() => {}) : actual.readJsonFileAsync(file),
	};
});

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");
const UNLISTED = Array.from({ length: 70 }, (_, index) => `~/.t3/unlisted/d${index}`).join(" ");

describe.each([
	["a symlinked $HOME", "home"],
	["a symlinked ~/.t3", "legacy-root"],
	["no symlink", "none"],
] as const)("moved-path-guard text fallback with %s (#2898)", (_label, symlinked) => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];
	const extras: string[] = [];

	afterEach(() => {
		stall.breadcrumb = "";
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (extras.length > 0) rmSync(extras.pop() ?? "", { recursive: true, force: true });
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function setup(reused = false, trust = true) {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		if (reused) {
			mkdirSync(join(layout.oldWorktree, "src"), { recursive: true });
			writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
		}
		if (symlinked === "home") {
			const link = `${layout.home}-link`;
			symlinkSync(layout.home, link);
			extras.push(link);
			vi.stubEnv("HOME", link);
		} else if (symlinked === "legacy-root") {
			const external = `${layout.home}-ext-t3`;
			renameSync(layout.oldRoot, external);
			symlinkSync(external, layout.oldRoot);
			extras.push(external);
		}
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const trustCall = reused ? `touch ~/.t3/${MOVED_WORKTREE}/src/a.ts` : `touch ~/.t3/${MOVED_WORKTREE}/a`;
		if (trust)
			expect(await runTool(harness, "bash", { command: trustCall })).toMatchObject({
				outcome: reused ? "ok" : "blocked",
			});
		const stallBreadcrumb = () => {
			stall.breadcrumb = join(realpathSync(layout.oldRoot), "omo-desktop-moved.json");
		};
		return { layout, harness, stallBreadcrumb };
	}

	it("refuses a moved target behind 70 unlisted legacy paths", async () => {
		const { layout, harness } = await setup();

		const result = await runTool(harness, "bash", { command: `touch ${UNLISTED} ~/.t3/${MOVED_WORKTREE}/b` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "b"));
	});

	it("refuses a moved target whose breadcrumb read times out", async () => {
		const { layout, harness, stallBreadcrumb } = await setup();
		stallBreadcrumb();

		const result = await runTool(harness, "bash", { command: `touch ~/.t3/${MOVED_WORKTREE}/c` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "c"));
	});

	// Seventh review LOW-B: when the path's own canonicalization times out the walk meets the old root by its called
	// spelling, which is the symlink itself for a symlinked ~/.t3; the folder check follows it to the real folder.
	it("refuses a first call whose canonical step times out", async () => {
		const { layout, harness } = await setup(false, false);

		const result = await runTool(harness, "bash", { command: `touch ~/.t3/${MOVED_WORKTREE}/SLOW` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "SLOW"));
	});

	it("allows a re-used worktree whose breadcrumb read times out after it was found re-used", async () => {
		const { harness, stallBreadcrumb } = await setup(true);
		stallBreadcrumb();

		const result = await runTool(harness, "bash", { command: `touch ~/.t3/${MOVED_WORKTREE}/src/b.ts` });

		expect(result.outcome).toBe("ok");
	});
});

// Seventh review LOW-A: a same-named symlink elsewhere (~/code/worktrees -> ~/.t3/worktrees) must not make ~/code an
// old-root spelling, or a live ~/code/userdata/omo-sessions path is refused when a step times out.
describe("moved-path-guard called spelling of an old root (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		stall.breadcrumb = "";
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	it("does not take a same-named symlink's parent for the old root", async () => {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		const code = join(layout.home, "code");
		mkdirSync(join(layout.oldRoot, "worktrees", "app"), { recursive: true });
		mkdirSync(join(layout.oldRoot, "unlisted"), { recursive: true });
		mkdirSync(join(code, "userdata", "omo-sessions"), { recursive: true });
		symlinkSync(join(layout.oldRoot, "worktrees"), join(code, "worktrees"));
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(await runTool(harness, "bash", { command: "touch ~/code/worktrees/app/w1/a" })).toMatchObject({
			outcome: "blocked",
		});
		stall.breadcrumb = join(layout.oldRoot, "omo-desktop-moved.json");

		const result = await runTool(harness, "bash", {
			command: "touch ~/.t3/unlisted/q ~/code/userdata/omo-sessions/x",
		});

		expect(result.outcome).toBe("ok");
	});

	// Seventh-review delta check: the folder step follows a symlink only at a legacy root under the home. Anywhere else
	// another user could repoint the link between the breadcrumb read and the folder check, so a breadcrumb read through
	// a shared folder would be judged by the owner and mode of a folder the user owns.
	it("does not follow a symlink that is not a legacy root to judge the breadcrumb's folder", async () => {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		symlinkSync(layout.oldRoot, join(layout.home, "elsewhere"));
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const result = await runTool(harness, "bash", { command: `touch ~/elsewhere/${MOVED_WORKTREE}/SLOW` });

		expect(result.outcome).toBe("ok");
	});
});
