import { afterEach, describe, expect, it } from "vitest";
import { buildCorpus } from "./fixtures/build-corpus.ts";

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
		const files = await (await import("node:fs/promises")).readdir(corpus.root, {
			recursive: true,
			withFileTypes: true,
		});
		const actual: Record<string, number> = {};
		for (const entry of files) {
			if (!entry.isFile()) continue;
			const relative = entry.parentPath
				? (await import("node:path")).relative(corpus.root, `${entry.parentPath}/${entry.name}`)
				: entry.name;
			actual[relative] = (await (await import("node:fs/promises")).stat(`${corpus.root}/${relative}`)).size;
		}
		expect(actual).toEqual(expected);
		expect(files.filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name)).toEqual(["loop"]);
	});
});
