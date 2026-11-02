import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createHarness, type Harness } from "./harness.ts";
import {
	breadcrumbBody,
	createMovedLayout,
	MOVED_SESSIONS,
	MOVED_WORKTREE,
	type MovedLayout,
	runTool,
	writeBreadcrumb,
} from "./moved-path-guard-fixtures.ts";

/**
 * code-yeongyu/senpi#2898: after the OmO desktop moves its data home, the builtin `moved-path-guard` refuses
 * file-tool writes into the old root's moved prefixes and turns a read of a moved, missing path into a hint
 * naming the new location, through the real tools and the registered filesystem policy.
 */

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");

describe("moved-path-guard: file tools (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function setup(options: { breadcrumb?: boolean; schemaVersion?: number } = {}) {
		if (!guard) throw new Error("moved-path-guard is not a registered builtin extension");
		const layout = createMovedLayout(options);
		layouts.push(layout);
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["read", "write", "edit", "ls", "find"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { layout, harness };
	}

	it("refuses write and edit into a moved prefix and names the new path", async () => {
		const { layout, harness } = await setup();
		const oldFile = join(layout.oldWorktree, "src", "a.ts");
		const newFile = join(layout.newWorktree, "src", "a.ts");

		const write = await runTool(harness, "write", { path: oldFile, content: "x" });
		const edit = await runTool(harness, "edit", { path: oldFile, edits: [{ oldText: "x", newText: "y" }] });

		for (const result of [write, edit]) {
			expect(result.outcome).toBe("error");
			expect(result.text).toContain(`This folder moved to ${layout.newRoot}.`);
			expect(result.text).toContain(newFile);
		}
		expect(existsSync(layout.oldWorktree)).toBe(false);
	});

	it("turns a read, ls, or find of a missing moved path into the new location", async () => {
		const { layout, harness } = await setup();
		const oldSession = join(layout.oldSessions, "s.jsonl");

		const read = await runTool(harness, "read", { path: oldSession });
		const ls = await runTool(harness, "ls", { path: layout.oldWorktree });
		const find = await runTool(harness, "find", { pattern: "*.ts", path: layout.oldWorktree });

		expect(read.text).toContain(join(layout.newSessions, "s.jsonl"));
		expect(ls.text).toContain(layout.newWorktree);
		expect(find.text).toContain(layout.newWorktree);
	});

	it("leaves a T3 Code worktree that reuses a moved path alone, because it has its own .git", async () => {
		const { layout, harness } = await setup();
		mkdirSync(layout.oldWorktree, { recursive: true });
		writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
		writeFileSync(join(layout.oldWorktree, "kept.txt"), "t3code\n");

		const read = await runTool(harness, "read", { path: join(layout.oldWorktree, "kept.txt") });
		const write = await runTool(harness, "write", { path: join(layout.oldWorktree, "new.txt"), content: "ok" });

		expect(read).toMatchObject({ outcome: "ok" });
		expect(read.text).toContain("t3code");
		expect(write).toMatchObject({ outcome: "ok" });
		expect(readFileSync(join(layout.oldWorktree, "new.txt"), "utf8")).toBe("ok");
	});

	it("allows an unlisted path under the breadcrumb and a sibling that only shares a name prefix", async () => {
		const { layout, harness } = await setup();
		const unlisted = join(layout.oldRoot, "userdata", "statev2.sqlite");
		const sibling = join(layout.oldRoot, `${MOVED_WORKTREE}-x`, "a.txt");

		expect(await runTool(harness, "write", { path: unlisted, content: "t3" })).toMatchObject({ outcome: "ok" });
		expect(await runTool(harness, "write", { path: sibling, content: "t3" })).toMatchObject({ outcome: "ok" });
	});

	it("refuses nothing without a breadcrumb", async () => {
		const { layout, harness } = await setup({ breadcrumb: false });
		const target = join(layout.oldWorktree, "a.txt");

		expect(await runTool(harness, "write", { path: target, content: "x" })).toMatchObject({ outcome: "ok" });
		expect(readFileSync(target, "utf8")).toBe("x");
	});

	it("ignores a breadcrumb with a newer schemaVersion", async () => {
		const { layout, harness } = await setup({ schemaVersion: 2 });

		expect(
			await runTool(harness, "write", { path: join(layout.oldSessions, "s.jsonl"), content: "x" }),
		).toMatchObject({ outcome: "ok" });
	});

	it("sees a breadcrumb written after an earlier call in the same session", async () => {
		const { layout, harness } = await setup({ breadcrumb: false });
		const early = join(layout.oldSessions, "early.jsonl");
		const target = join(layout.oldSessions, "late.jsonl");
		expect(await runTool(harness, "write", { path: early, content: "x" })).toMatchObject({ outcome: "ok" });
		writeBreadcrumb(layout.oldRoot, breadcrumbBody(layout.newRoot, [MOVED_SESSIONS]));

		expect(await runTool(harness, "write", { path: target, content: "x" })).toMatchObject({ outcome: "error" });
	});
});
