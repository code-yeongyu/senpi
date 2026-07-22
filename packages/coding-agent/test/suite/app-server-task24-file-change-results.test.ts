import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parsePatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import { fileChangeProjection } from "../../src/modes/app-server/threads/projection-file-changes.ts";
import { createHarness, type Harness } from "./harness.ts";

const tempRoots: string[] = [];
const harnesses: Harness[] = [];
const execFileAsync = promisify(execFile);

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-task24-file-change-"));
	tempRoots.push(root);
	return root;
}

async function createApplyPatchHarness(): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	return harness;
}

async function executeApplyPatch(harness: Harness, input: string) {
	const tool = createApplyPatchTool();
	return tool.execute("apply-call", { input }, undefined, undefined, harness.session.extensionRunner.createContext());
}

afterEach(async () => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("app-server task 24 real file-change result contracts", () => {
	it("projects the real edit result as a source-backed unified diff", async () => {
		// Given: an existing file and the real edit tool.
		const root = await createTempRoot();
		await writeFile(join(root, "edit.txt"), "before\n", "utf8");

		// When: the edit executes and its exact result is projected.
		const result = await createEditTool(root).execute("edit-call", {
			path: "edit.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
		const projection = fileChangeProjection({
			id: "edit-call",
			name: "edit",
			args: { path: "edit.txt" },
			status: "completed",
			result,
		});

		// Then: the change has one parseable patch with the edited path.
		expect(projection.item).toMatchObject({
			changes: [{ path: "edit.txt", kind: { type: "update", move_path: null } }],
		});
		expect(parsePatch(projection.diff)).toMatchObject([{ oldFileName: "edit.txt", newFileName: "edit.txt" }]);
	});

	it("projects the real write result as a source-backed unified diff", async () => {
		// Given: an existing file and the real write tool.
		const root = await createTempRoot();
		await writeFile(join(root, "write.txt"), "before\n", "utf8");

		// When: write overwrites the file and its exact result is projected.
		const result = await createWriteTool(root).execute("write-call", { path: "write.txt", content: "after\n" });
		const projection = fileChangeProjection({
			id: "write-call",
			name: "write",
			args: { path: "write.txt", content: "after\n" },
			status: "completed",
			result,
		});

		// Then: the overwrite is visible as one parseable update patch.
		expect(projection.item).toMatchObject({
			changes: [{ path: "write.txt", kind: { type: "update", move_path: null } }],
		});
		expect(parsePatch(projection.diff)).toMatchObject([{ oldFileName: "write.txt", newFileName: "write.txt" }]);
	});

	it("delimits every file in a real multi-file apply_patch result", async () => {
		// Given: two existing files and one real multi-file patch.
		const harness = await createApplyPatchHarness();
		const root = harness.tempDir;
		await writeFile(join(root, "one.txt"), "old one\n", "utf8");
		await writeFile(join(root, "two.txt"), "old two\n", "utf8");
		const input = `*** Begin Patch
*** Update File: one.txt
@@
-old one
+new one
*** Update File: two.txt
@@
-old two
+new two
*** End Patch`;

		// When: the patch executes and its exact result is projected.
		const result = await executeApplyPatch(harness, input);
		const projection = fileChangeProjection({
			id: "apply-call",
			name: "apply_patch",
			args: { input },
			status: "completed",
			result,
		});

		// Then: both source files are separate parseable unified patches in patch order.
		expect(projection.item).toMatchObject({
			changes: [
				{ path: "one.txt", kind: { type: "update", move_path: null } },
				{ path: "two.txt", kind: { type: "update", move_path: null } },
			],
		});
		expect(parsePatch(projection.diff)).toMatchObject([
			{ oldFileName: "one.txt", newFileName: "one.txt" },
			{ oldFileName: "two.txt", newFileName: "two.txt" },
		]);
	});

	it("keeps only successful unified patches from a partial apply_patch result", async () => {
		// Given: a patch whose first file exists and whose second file is missing.
		const harness = await createApplyPatchHarness();
		const root = harness.tempDir;
		await writeFile(join(root, "ok.txt"), "old\n", "utf8");
		const input = `*** Begin Patch
*** Update File: ok.txt
@@
-old
+new
*** Update File: missing.txt
@@
-missing
+fixed
*** End Patch`;

		// When: the real tool partially succeeds and its exact result is projected.
		const result = await executeApplyPatch(harness, input);
		const projection = fileChangeProjection({
			id: "apply-call",
			name: "apply_patch",
			args: { input },
			status: "completed",
			result,
		});

		// Then: the successful source mutation remains visible and the failed file is absent.
		expect(projection.item).toMatchObject({
			changes: [{ path: "ok.txt", kind: { type: "update", move_path: null } }],
		});
		expect(parsePatch(projection.diff)).toMatchObject([{ oldFileName: "ok.txt", newFileName: "ok.txt" }]);
		expect(projection.diff).not.toContain("missing.txt");
	});

	it("represents a real move-only apply_patch result with old and new paths", async () => {
		// Given: a source file and a move-only patch.
		const harness = await createApplyPatchHarness();
		const root = harness.tempDir;
		await writeFile(join(root, "old-name.txt"), "same\n", "utf8");
		const input = `*** Begin Patch
*** Update File: old-name.txt
*** Move to: new-name.txt
*** End Patch`;

		// When: the move executes and its exact result is projected.
		const result = await executeApplyPatch(harness, input);
		const projection = fileChangeProjection({
			id: "apply-call",
			name: "apply_patch",
			args: { input },
			status: "completed",
			result,
		});

		// Then: the source path and move destination use the v2 shape, and the diff replays the filesystem mutation.
		const replayRoot = await createTempRoot();
		await writeFile(join(replayRoot, "old-name.txt"), "same\n", "utf8");
		await writeFile(join(replayRoot, "move.patch"), projection.diff, "utf8");
		await execFileAsync("git", ["apply", "--check", "move.patch"], { cwd: replayRoot });
		await execFileAsync("git", ["apply", "move.patch"], { cwd: replayRoot });
		expect(projection.item).toMatchObject({
			changes: [{ path: "old-name.txt", kind: { type: "update", move_path: "new-name.txt" } }],
		});
		expect(parsePatch(projection.diff)).toMatchObject([
			{ oldFileName: "a/old-name.txt", newFileName: "/dev/null" },
			{ oldFileName: "/dev/null", newFileName: "b/new-name.txt" },
		]);
		await expect(readFile(join(root, "old-name.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "new-name.txt"), "utf8")).toBe("same\n");
		await expect(readFile(join(replayRoot, "old-name.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(replayRoot, "new-name.txt"), "utf8")).toBe("same\n");
	});
});
