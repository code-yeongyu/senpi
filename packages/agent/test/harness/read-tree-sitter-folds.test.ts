import { describe, expect, it } from "vitest";
import {
	READ_FOLD_SETTINGS,
	readSummaryEngineForPath,
	selectedReadFolder,
} from "../../src/harness/utils/read-folders/index.ts";
import { prepareReadFolder } from "../../src/harness/utils/read-folders/prepare.ts";
import {
	loadTreeSitterFolder,
	TREE_SITTER_FOLDER_ID,
} from "../../src/harness/utils/read-folders/tree-sitter/engine.ts";
import type { TreeSitterLanguage } from "../../src/harness/utils/read-folders/tree-sitter/syntax.ts";
import type {
	ReadFolder,
	ReadFolderInput,
	ReadFolderResult,
	ReadFoldRange,
} from "../../src/harness/utils/read-folders/types.ts";
import { typescriptOracle } from "./fixtures/read-summary/oracle-typescript.ts";
import { type Fold, validBoundaries } from "./fixtures/read-summary/scorer.ts";

const extensions: Record<TreeSitterLanguage, string> = { ts: "ts", tsx: "tsx", js: "js" };

async function folder(language: TreeSitterLanguage, options = {}): Promise<ReadFolder> {
	const loaded = await loadTreeSitterFolder(language, { fallback: selectedReadFolder, cache: false, ...options });
	if (!loaded) throw new Error(`grammar unavailable for ${language}`);
	return loaded;
}
function flatten(parsed: ReadFolderResult): Fold[] {
	const ranges: ReadFoldRange[] = parsed.status === "parsed" ? [...parsed.ranges] : [];
	for (let index = 0; index < ranges.length; index++) ranges.push(...ranges[index].children);
	return ranges.map((range) => ({ start: range.startLine, end: range.endLine })).sort((a, b) => a.start - b.start);
}
function fold(engine: ReadFolder, language: TreeSitterLanguage, text: string): ReadFolderResult {
	return engine.fold({ path: `input.${extensions[language]}`, text, settings: READ_FOLD_SETTINGS });
}
/** Oracle bodies the shipped policy is allowed to omit: the engine must find exactly these. */
function expectedFolds(source: string, language: TreeSitterLanguage): Fold[] {
	return typescriptOracle(source, language)
		.allowed.filter((range) => range.end - range.start + 1 >= READ_FOLD_SETTINGS.minBodyLines)
		.map((range) => ({ start: range.start, end: range.end }))
		.sort((a, b) => a.start - b.start);
}

const typescriptSource = Array.from({ length: 20 }, (_, index) =>
	[
		`export function example${index}(input: { value: number }): number {`,
		`  const doubled = input.value * 2;`,
		`  const label = \`value \${doubled}\`;`,
		`  const parsed = Number.parseInt(label.slice(6), 10);`,
		`  return parsed + doubled;`,
		"}",
	].join("\n"),
).join("\n");

const tsxSource = Array.from({ length: 20 }, (_, index) =>
	[
		`export function Panel${index}({ title }: { title: string }) {`,
		`  const items = ["alpha", "bravo", "charlie"];`,
		`  const label = title.toUpperCase();`,
		`  const total = items.length;`,
		`  return <section title={label}>{total}</section>;`,
		"}",
	].join("\n"),
).join("\n");

const javascriptSource = Array.from({ length: 20 }, (_, index) =>
	[
		`function handler${index}(request) {`,
		`  const headers = request.headers;`,
		`  const accepted = headers.accept || "*/*";`,
		`  const trimmed = accepted.trim();`,
		`  return { accepted: trimmed, index: ${index} };`,
		"}",
	].join("\n"),
).join("\n");

describe("tree-sitter fold boundaries (#1685)", () => {
	it.each([
		["ts", typescriptSource],
		["tsx", tsxSource],
		["js", javascriptSource],
	] as const)("produces the compiler oracle's omittable bodies for %s", async (language, source) => {
		// Given a real declaration corpus and the grammar-backed engine.
		const engine = await folder(language);
		expect(engine.id).toBe(TREE_SITTER_FOLDER_ID);
		// When folding; then every body the oracle allows is found, and nothing else is.
		const parsed = fold(engine, language, source);
		expect(parsed.status).toBe("parsed");
		const folds = flatten(parsed);
		expect(folds.length).toBeGreaterThan(0);
		expect(folds).toEqual(expectedFolds(source, language));
		const oracle = typescriptOracle(source, language);
		for (const candidate of folds)
			expect(
				validBoundaries({ source, folds: [candidate], ...oracle, retainedExact: true }),
				JSON.stringify(candidate),
			).toBe(true);
	});

	it("keeps a declaration header out of every omitted range", async () => {
		// Given a nested declaration inside an otherwise foldable object literal.
		const source = [
			"const registry = {",
			"  build(options) {",
			"    const mode = options.mode;",
			"    const retries = options.retries;",
			"    const timeout = options.timeout;",
			"    return { mode, retries, timeout };",
			"  },",
			"};",
		].join("\n");
		const engine = await folder("js");
		// When folding; then the enclosing literal is rejected and only the method body is omitted.
		expect(flatten(fold(engine, "js", source))).toEqual([{ start: 3, end: 6 }]);
	});

	it("falls back to the heuristic scan on a malformed file", async () => {
		// Given source the grammar cannot parse.
		const source = `${javascriptSource}\nfunction broken( {`;
		const engine = await folder("js");
		// When folding; then the shipped fallback result is used verbatim, never a partial tree.
		expect(fold(engine, "js", source)).toEqual(
			selectedReadFolder.fold({ path: "input.js", text: source, settings: READ_FOLD_SETTINGS }),
		);
	});

	it("falls back when the parse budget is exhausted", async () => {
		// Given a zero-millisecond budget, the parse is cancelled at its first progress checkpoint.
		const engine = await folder("js", { parseBudgetMs: 0 });
		const parsed = fold(engine, "js", javascriptSource);
		// Then the heuristic result stands in, and the next read with a real budget still folds.
		expect(parsed).toEqual(
			selectedReadFolder.fold({ path: "input.js", text: javascriptSource, settings: READ_FOLD_SETTINGS }),
		);
		expect(flatten(fold(await folder("js"), "js", javascriptSource)).length).toBeGreaterThan(0);
	});

	it("keeps the heuristic folder when the grammar is absent", async () => {
		// Given a resolver that finds no grammar file for a selected language.
		const prepared = await prepareReadFolder("input.js", selectedReadFolder, {
			cache: false,
			resolveGrammar: async () => undefined,
		});
		// Then the default read keeps the measured heuristic folder instead of failing.
		expect(prepared).toBe(selectedReadFolder);
		expect(
			await loadTreeSitterFolder("js", {
				fallback: selectedReadFolder,
				cache: false,
				resolveGrammar: async () => undefined,
			}),
		).toBeUndefined();
	});

	it("prepares the grammar-backed folder for exactly the languages frozen to wasm", async () => {
		// Given every language the selection names, when preparing the folder a default read will use.
		for (const path of ["input.ts", "input.tsx", "input.js", "input.json", "input.md", "input.py", "input.unknown"]) {
			const prepared = await prepareReadFolder(path, selectedReadFolder, { cache: false });
			// Then a wasm selection binds the grammar engine and every other selection keeps the heuristic.
			expect(prepared?.id, path).toBe(
				readSummaryEngineForPath(path) === "wasm" ? TREE_SITTER_FOLDER_ID : selectedReadFolder.id,
			);
		}
		expect(await prepareReadFolder("input.js", undefined, { cache: false })).toBeUndefined();
	});

	it("never replaces a caller-supplied folder with the grammar engine", async () => {
		// Given a reader that injected its own structural folder for a language frozen to wasm.
		const injected: ReadFolder = Object.freeze({
			id: "injected",
			version: "1",
			fold: ({ text }: ReadFolderInput) => ({ status: "parsed" as const, text, ranges: [] }),
		});
		// Then the selection decides eligibility, and the caller keeps exactly the folder it passed.
		expect(await prepareReadFolder("input.js", injected, { cache: false })).toBe(injected);
	});
});
