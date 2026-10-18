import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchDetailed } from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";

const tempDirectories: string[] = [];

async function workspace(files: Record<string, string>): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "senpi-apply-patch-headers-"));
	tempDirectories.push(cwd);
	for (const [name, content] of Object.entries(files)) await writeFile(path.join(cwd, name), content);
	return cwd;
}

async function exists(filePath: string): Promise<boolean> {
	return stat(filePath).then(
		() => true,
		() => false,
	);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Protects the apply_patch file-header contract shared by the parser and the permission system's per-file
// approval: an indented header used to drop its whole section while the patch reported success.
describe("gpt-apply-patch file headers", () => {
	it("applies a section whose update header is indented after a delete section", async () => {
		const cwd = await workspace({ "old.txt": "x\n", "b.txt": "b1\n" });

		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Delete File: old.txt\n  *** Update File: b.txt\n@@\n-b1\n+B1\n*** End Patch\n",
		);

		expect(result.failures).toEqual([]);
		expect(result.appliedFiles).toEqual(["old.txt", "b.txt"]);
		expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B1\n");
	});

	it("rejects the whole patch when a stray line sits between file sections, changing nothing", async () => {
		const cwd = await workspace({ "old.txt": "x\n", "b.txt": "b1\n" });

		await expect(
			applyPatchDetailed(
				cwd,
				"*** Begin Patch\n*** Delete File: old.txt\nnow update b\n@@\n-b1\n+B1\n*** End Patch\n",
			),
		).rejects.toThrow("'now update b' is not a valid hunk header");
		expect(await exists(path.join(cwd, "old.txt"))).toBe(true);
		expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("b1\n");
	});

	it("keeps an indented marker inside an update hunk as a context line", async () => {
		const cwd = await workspace({ "notes.md": "intro\n *** Update File: x\nend\n" });

		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: notes.md\n@@\n intro\n  *** Update File: x\n-end\n+END\n*** End Patch\n",
		);

		expect(result.failures).toEqual([]);
		expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("intro\n *** Update File: x\nEND\n");
	});

	it("asks per-file approval for exactly the files the patch writes, whatever whitespace pads the headers", async () => {
		const cwd = await workspace({ "old.txt": "x\n", "b.txt": "b1\n", "c.txt": "c1\n" });
		const patch =
			"*** Begin Patch\n*** Delete File: old.txt\n\u00A0*** Update File: b.txt\u00A0\n@@\n-b1\n+B1\n" +
			"*** Update File: c.txt\u00A0\n*** Move to: moved.txt  \n@@\n-c1\n+C1\n*** End Patch\n";

		const approvals = createBuiltinParserRegistry().parse("apply_patch", { input: patch }, cwd);
		const result = await applyPatchDetailed(cwd, patch);

		expect(result.failures).toEqual([]);
		expect(approvals.flatMap((approval) => approval.patterns)).toEqual(["old.txt", "b.txt", "c.txt", "moved.txt"]);
		expect(result.appliedFiles).toEqual(["old.txt", "b.txt", "moved.txt"]);
		expect(await readFile(path.join(cwd, "moved.txt"), "utf8")).toBe("C1\n");
		expect(await exists(path.join(cwd, "c.txt"))).toBe(false);
	});
});
