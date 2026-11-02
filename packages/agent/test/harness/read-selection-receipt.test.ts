import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { READ_FOLDER_SELECTION, selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";
import {
	GRAMMAR_FILES,
	packagedAssetDirectory,
} from "../../src/harness/utils/read-folders/tree-sitter/grammar-assets.ts";
import { adversarialPrograms } from "./fixtures/read-summary/adversarial-grammar.ts";
import { sha256 } from "./fixtures/read-summary/scorer.ts";
import { treeSitterProvenance } from "./fixtures/read-summary/tree-sitter-assets.ts";

it("binds the shipped registry to a tracked, reproducible selection receipt (#1639)", () => {
	const receipt = new URL("./fixtures/read-summary/selection.json", import.meta.url);
	const bytes = readFileSync(receipt);
	const selection = JSON.parse(bytes.toString("utf8"));
	const trackedPath = relative(process.cwd(), fileURLToPath(receipt));
	expect(execFileSync("git", ["ls-files", "--error-unmatch", trackedPath], { encoding: "utf8" }).trim()).toBe(
		trackedPath,
	);
	expect(sha256(bytes)).toBe(READ_FOLDER_SELECTION.selectionSha256);
	expect(selection.head_sha).toBe(READ_FOLDER_SELECTION.head);
	expect(selection.default_read_selection).toEqual({
		wasm: READ_FOLDER_SELECTION.wasm,
		rawReasons: READ_FOLDER_SELECTION.rawReasons,
		languages: READ_FOLDER_SELECTION.languages,
		folder: { id: selectedReadFolder.id, version: selectedReadFolder.version },
	});
	// The frozen decision must come from a run of the current adversarial grammar, with no counterexample.
	expect(selection.enumeration.grammarSha256).toBe(sha256(JSON.stringify(adversarialPrograms())));
	expect(selection.enumeration.counterexamples).toEqual([]);
	for (const language of ["ts", "js", "json"] as const) {
		const row = selection.languages.find((entry: { language: string }) => entry.language === language);
		expect(row.invalid_boundaries).toEqual([]);
		expect(row.engine).toBe(READ_FOLDER_SELECTION.languages[language]);
	}
	for (const [path, hash] of Object.entries(selection.candidate_sources_sha256)) {
		expect(sha256(readFileSync(new URL(`../../src/harness/utils/${path}`, import.meta.url)))).toBe(hash);
	}
});

it("freezes every per-language engine from the measured bake-off rows (#1685)", () => {
	const selection = JSON.parse(
		readFileSync(new URL("./fixtures/read-summary/selection.json", import.meta.url), "utf8"),
	);
	const rows = new Map<string, { engine: string; reason?: string }>(
		selection.languages.map((row: { language: string }) => [row.language, row]),
	);
	for (const [language, engine] of Object.entries(READ_FOLDER_SELECTION.languages)) {
		const row = rows.get(language);
		if (engine === "prose_exempt" || !row) continue;
		// A shipped engine must be the engine that won its measurement; anything else reads raw.
		expect(row.engine, language).toBe(engine === "heuristic" || engine === "wasm" ? engine : "raw");
	}
	expect(READ_FOLDER_SELECTION.wasm).toBe(Object.values(READ_FOLDER_SELECTION.languages).includes("wasm"));
	const rawReasons: Record<string, string> = READ_FOLDER_SELECTION.rawReasons;
	for (const [language, reason] of Object.entries(rawReasons)) {
		expect(READ_FOLDER_SELECTION.languages[language as keyof typeof READ_FOLDER_SELECTION.languages]).toBe("raw");
		expect(reason, language).toBe(rows.get(language)?.reason);
		// The owner decided WASM in #1685: no language may still claim a pending owner decision.
		expect(reason).not.toContain("pending_owner");
	}
	for (const [language, engine] of Object.entries(READ_FOLDER_SELECTION.languages))
		if (engine === "raw") expect(Object.keys(rawReasons), language).toContain(language);
});

it("ships a vendored grammar for every language frozen to the grammar engine (#1685)", () => {
	const provenance = treeSitterProvenance();
	const shipped = new Map(provenance.grammars.map((grammar) => [grammar.language, grammar]));
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	expect(manifest.files).toContain("assets");
	expect(manifest.dependencies["web-tree-sitter"]).toBe(provenance.runtime.version);
	for (const artifact of [provenance.runtime, ...provenance.grammars])
		expect(sha256(readFileSync(join(packagedAssetDirectory, artifact.file))), artifact.file).toBe(artifact.sha256);
	for (const [language, engine] of Object.entries(READ_FOLDER_SELECTION.languages)) {
		if (engine !== "wasm") continue;
		const grammar = shipped.get(language);
		expect(grammar?.file, language).toBe(GRAMMAR_FILES[language as keyof typeof GRAMMAR_FILES]);
	}
	// Nothing ships that no selection uses: the binary carries measured grammars only.
	for (const grammar of provenance.grammars)
		expect(
			READ_FOLDER_SELECTION.languages[grammar.language as keyof typeof READ_FOLDER_SELECTION.languages],
			grammar.language,
		).toBe("wasm");
});
