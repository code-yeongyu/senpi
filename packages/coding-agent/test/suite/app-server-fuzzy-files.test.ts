import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectFuzzyFileEntries,
	FUZZY_SEARCH_MAX_DEPTH,
	FUZZY_SEARCH_MAX_VISITED_ENTRIES,
	FUZZY_SEARCH_RESULT_LIMIT,
	type FuzzyFileEntry,
	rankFuzzyFileEntries,
} from "../../src/modes/app-server/search/fuzzy-files.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("app-server fuzzy file traversal and scoring", () => {
	it("orders matches by score and returns sorted path indices", () => {
		// Given: one contiguous filename match and one gapped filename match.
		const entries = [entry("a-x-b-x-c.txt"), entry("abc.txt")];

		// When: the entries are ranked for a case-insensitive subsequence.
		const ranked = rankFuzzyFileEntries("ABC", entries);

		// Then: contiguity wins and the highlighted path indices are ascending.
		expect(ranked.map((result) => result.path)).toEqual(["abc.txt", "a-x-b-x-c.txt"]);
		expect(ranked[0]?.indices).toEqual([0, 1, 2]);
		expect(ranked[1]?.indices).toEqual([0, 4, 8]);
	});

	it.each([
		{ candidate: "😀.txt", query: "😀", expected: [0] },
		{ candidate: "😀xA.txt", query: "😀A", expected: [0, 2] },
		{ candidate: "İ.txt", query: "İ", expected: [0] },
	])("returns original character indices for $candidate", ({ candidate, query, expected }) => {
		// Given: a filename whose normalized representation does not align with UTF-16 code units.
		const entries = [entry(candidate)];

		// When: the entry is ranked by a Unicode query.
		const ranked = rankFuzzyFileEntries(query, entries);

		// Then: indices address unique characters in the original path.
		expect(ranked[0]?.indices).toEqual(expected);
	});

	it("measures filename offsets in original path characters", () => {
		// Given: an astral character appears in the parent path before the filename match.
		const entries = [entry("😀/Alpha.ts")];

		// When: the filename is ranked.
		const ranked = rankFuzzyFileEntries("a", entries);

		// Then: the filename index is relative to path characters rather than UTF-16 code units.
		expect(ranked[0]?.indices).toEqual([2]);
	});

	it("prefers a filename match over a path-only match", () => {
		// Given: the same query in a parent directory and in a filename.
		const entries = [entry("abc-parent/zzz.txt"), entry("misc/abc.txt")];

		// When: both entries are ranked.
		const ranked = rankFuzzyFileEntries("abc", entries);

		// Then: the filename match ranks first even though both paths contain the query contiguously.
		expect(ranked.map((result) => result.path)).toEqual(["misc/abc.txt", "abc-parent/zzz.txt"]);
	});

	it("breaks exact score ties by relative path ascending", () => {
		// Given: two filename matches with the same score.
		const entries = [entry("zeta/ac.txt"), entry("alpha/ac.txt")];

		// When: the entries are ranked.
		const ranked = rankFuzzyFileEntries("ac", entries);

		// Then: relative path order is the deterministic tie breaker.
		expect(ranked.map((result) => result.path)).toEqual(["alpha/ac.txt", "zeta/ac.txt"]);
	});

	it("returns no matches for an empty query and caps results at the upstream limit", () => {
		// Given: more matching entries than the upstream result limit.
		const entries = Array.from({ length: FUZZY_SEARCH_RESULT_LIMIT + 2 }, (_, index) =>
			entry(`match-${String(index).padStart(2, "0")}.txt`),
		);

		// When: an empty query and a matching query are ranked.
		const empty = rankFuzzyFileEntries("", entries);
		const limited = rankFuzzyFileEntries("match", entries);

		// Then: empty search is bounded to zero and a real search uses Codex's limit of 50.
		expect(empty).toEqual([]);
		expect(FUZZY_SEARCH_RESULT_LIMIT).toBe(50);
		expect(limited).toHaveLength(50);
	});

	it("walks deterministically within the production depth and visited-entry bounds", async () => {
		// Given: a lexically unordered tree and a file beyond the configured depth.
		const root = await scratch("bounds");
		await writeFile(join(root, "c.txt"), "c");
		await writeFile(join(root, "a.txt"), "a");
		await writeFile(join(root, "b.txt"), "b");
		let current = root;
		for (let depth = 1; depth <= FUZZY_SEARCH_MAX_DEPTH; depth++) {
			current = join(current, `d${depth}`);
			await mkdir(current);
			await writeFile(join(current, `depth-${depth}.txt`), String(depth));
		}

		// When: the cap seam stops after two visited entries and the default walker scans the tree.
		const capped = await collectFuzzyFileEntries([root], { maxVisitedEntries: 2 });
		const walked = await collectFuzzyFileEntries([root]);

		// Then: cap order is lexical, defaults remain pinned, and depth thirteen is never visited.
		expect(FUZZY_SEARCH_MAX_DEPTH).toBe(12);
		expect(FUZZY_SEARCH_MAX_VISITED_ENTRIES).toBe(50_000);
		expect(capped.map((value) => value.path)).toEqual(["a.txt", "b.txt"]);
		expect(walked.some((value) => value.path.endsWith("depth-11.txt"))).toBe(true);
		expect(walked.some((value) => value.path.endsWith("depth-12.txt"))).toBe(false);
	});

	it("does not follow symlinks and applies built-in plus gitignore exclusions", async () => {
		// Given: visible files, ignored directories/files, and a symlink to a visible file.
		const root = await scratch("ignores");
		await mkdir(join(root, ".git"));
		await mkdir(join(root, "node_modules"));
		await mkdir(join(root, "nested"));
		await writeFile(join(root, ".git", "secret.ts"), "secret");
		await writeFile(join(root, "node_modules", "dependency.ts"), "dependency");
		await writeFile(join(root, "ignored.ts"), "ignored");
		await writeFile(join(root, "visible.ts"), "visible");
		await writeFile(join(root, "nested", "ignored.ts"), "ignored");
		await writeFile(join(root, "nested", "visible.ts"), "visible");
		await writeFile(join(root, ".gitignore"), "ignored.ts\nnested/ignored.ts\n");
		await symlink(join(root, "visible.ts"), join(root, "linked.ts"));

		// When: the root is traversed.
		const paths = (await collectFuzzyFileEntries([root])).map((value) => value.path);

		// Then: only real, non-ignored entries remain, including directories as supported by the protocol.
		expect(paths).toContain("visible.ts");
		expect(paths).toContain("nested");
		expect(paths).toContain("nested/visible.ts");
		expect(paths).not.toContain("ignored.ts");
		expect(paths).not.toContain("nested/ignored.ts");
		expect(paths).not.toContain("linked.ts");
		expect(paths.some((value) => value.startsWith(".git/"))).toBe(false);
		expect(paths.some((value) => value.startsWith("node_modules/"))).toBe(false);
	});

	it("applies basename rules from nested gitignores throughout their subtree", async () => {
		// Given: a nested gitignore basename rule, a deeper match, and the same basename outside its scope.
		const root = await scratch("nested-ignore");
		await mkdir(join(root, "nested", "deeper"), { recursive: true });
		await mkdir(join(root, "sibling"));
		await writeFile(join(root, "nested", ".gitignore"), "ignored.ts\n");
		await writeFile(join(root, "nested", "ignored.ts"), "ignored");
		await writeFile(join(root, "nested", "deeper", "ignored.ts"), "ignored");
		await writeFile(join(root, "sibling", "ignored.ts"), "visible");

		// When: the root is traversed.
		const paths = (await collectFuzzyFileEntries([root])).map((value) => value.path);

		// Then: the nested rule covers all descendants without leaking into siblings.
		expect(paths).not.toContain("nested/ignored.ts");
		expect(paths).not.toContain("nested/deeper/ignored.ts");
		expect(paths).toContain("sibling/ignored.ts");
	});
});

function entry(path: string): FuzzyFileEntry {
	const parts = path.split("/");
	return {
		root: "/fixture",
		path,
		matchType: "file",
		fileName: parts.at(-1) ?? path,
	};
}

async function scratch(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `senpi-fuzzy-${label}-`));
	roots.push(root);
	return root;
}
