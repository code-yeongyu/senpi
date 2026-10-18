import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchDetailed } from "../../../src/core/extensions/builtin/gpt-apply-patch/apply.ts";
import { parsePatch } from "../../../src/core/extensions/builtin/gpt-apply-patch/parser.ts";

// Combined regression for the 2656 main-merge: one CRLF patch with an indented file header and a
// `+` line that duplicates a context line must apply (#2637), keep CRLF (#2639), and count (+1 -0).

const tempDirectories: string[] = [];

async function workspaceWith(name: string, content: string): Promise<{ cwd: string; file: string }> {
	const cwd = await mkdtemp(path.join(tmpdir(), "senpi-apply-patch-merge-"));
	tempDirectories.push(cwd);
	const file = path.join(cwd, name);
	await writeFile(file, content);
	return { cwd, file };
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function hunkChangeCounts(hunks: ReturnType<typeof parsePatch>): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		if (hunk.type !== "update") continue;
		for (const chunk of hunk.chunks) {
			added += chunk.addedCount;
			removed += chunk.removedCount;
		}
	}
	return { added, removed };
}

describe("apply_patch main-merge: indented header + CRLF + duplicate-line count", () => {
	it("applies an indented-header patch on a CRLF file, keeps CRLF, and counts (+1 -0)", async () => {
		const { cwd, file } = await workspaceWith("code.ts", "const a = 1;\r\nconst b = 2;\r\n");

		// Indented file header (#2637) and a `+` line whose text duplicates the context line `const a = 1;`.
		const patchText = [
			"*** Begin Patch",
			"   *** Update File: code.ts",
			"@@",
			" const a = 1;",
			"+const a = 1;",
			" const b = 2;",
			"*** End Patch",
		].join("\n");

		const result = await applyPatchDetailed(cwd, patchText);
		// #2637: the indented header is accepted and the hunk applies.
		expect(result.failures).toEqual([]);
		// #2639: CRLF is preserved on every line.
		expect(await readFile(file, "utf8")).toBe("const a = 1;\r\nconst a = 1;\r\nconst b = 2;\r\n");
		// 2656: the duplicate `+` line counts as one addition, no removal — not (+0 -0).
		expect(hunkChangeCounts(parsePatch(patchText))).toEqual({ added: 1, removed: 0 });
	});
});
