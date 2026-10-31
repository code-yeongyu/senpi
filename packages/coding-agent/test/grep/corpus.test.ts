import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCorpus } from "./fixtures/build-corpus.ts";

async function listTreeWithoutFollowingSymlinks(root: string): Promise<{ files: string[]; symlinks: string[] }> {
	const files: string[] = [];
	const symlinks: string[] = [];
	const pending = [root];
	for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
		const entries: Dirent[] = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) symlinks.push(relative(root, path));
			else if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) files.push(relative(root, path));
		}
	}
	return { files, symlinks };
}

const expected: Record<string, number> = {
	".gitignore": 9,
	".ignore": 9,
	"src/a.ts": 44,
	"src/z.ts": 15,
	"src/nested/deep/b.ts": 310,
	".hidden/h.ts": 7,
	"ignored/i.ts": 7,
	"scratch/s.ts": 7,
	"bin.dat": 15,
	"late-nul.bin": 70017,
	"big.txt": 5242880,
	"big-late-nul.txt": 5242880,
	"unicode.ts": 1807,
	"braces.ts": 9,
	"lookaround.ts": 11,
	"latin1.txt": 9,
};

describe("grep fixture corpus", () => {
	let corpus: Awaited<ReturnType<typeof buildCorpus>> | undefined;
	afterEach(async () => {
		await corpus?.cleanup();
	});
	it("materializes the exact deterministic corpus", async () => {
		corpus = await buildCorpus({ git: false });
		const root = corpus.root;
		const { files, symlinks } = await listTreeWithoutFollowingSymlinks(root);
		const actual: Record<string, number> = {};
		for (const file of files) actual[file] = (await stat(join(root, file))).size;
		expect(actual).toEqual(expected);
		expect(symlinks).toEqual(["loop"]);
	});
});
