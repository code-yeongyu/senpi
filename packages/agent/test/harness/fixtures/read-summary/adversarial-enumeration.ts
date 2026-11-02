import { Script } from "node:vm";
import * as ts from "@typescript/typescript6";
import { READ_FOLD_SETTINGS, selectedReadFolder } from "../../../../src/harness/utils/read-folders/index.ts";
import type { ReadFolder } from "../../../../src/harness/utils/read-folders/types.ts";
import { adversarialPrograms } from "./adversarial-grammar.ts";
import { typescriptOracle } from "./oracle-typescript.ts";
import { overlaps, sha256, validBoundaries } from "./scorer.ts";

export type EnumerationFolders = (language: "ts" | "js") => ReadFolder;

export function enumerateBoundaries(folders: EnumerationFolders = () => selectedReadFolder) {
	const programs = adversarialPrograms();
	let emittedRanges = 0;
	let protectedPrograms = 0;
	const counterexamples: { name: string; source: string; errors: string[] }[] = [];
	for (const program of programs) {
		const { source, language } = program;
		const errors: string[] = [];
		const syntax = ts.transpileModule(source, {
			reportDiagnostics: true,
			compilerOptions: { target: ts.ScriptTarget.Latest },
		});
		for (const diagnostic of syntax.diagnostics ?? [])
			if (diagnostic.category === ts.DiagnosticCategory.Error)
				errors.push(`syntax: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
		if (language === "js") {
			try {
				new Script(source);
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				errors.push(`syntax: ${error.message}`);
			}
		}
		const oracle = typescriptOracle(source, language);
		if (oracle.protected.length) protectedPrograms++;
		const parsed = folders(language).fold({ path: `input.${language}`, text: source, settings: READ_FOLD_SETTINGS });
		const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
		for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
		emittedRanges += ranges.length;
		for (const range of ranges) {
			const fold = { start: range.startLine, end: range.endLine };
			if (oracle.protected.some((p) => overlaps(fold, p))) errors.push(`protected overlap: ${JSON.stringify(fold)}`);
			// Qualify each hierarchical range separately; parents and children intentionally overlap one another.
			if (!validBoundaries({ source, folds: [fold], ...oracle, retainedExact: true }))
				errors.push(`invalid boundary: ${JSON.stringify(fold)}`);
		}
		if (errors.length) counterexamples.push({ name: program.name, source, errors });
	}
	return {
		programs: programs.length,
		grammarSha256: sha256(JSON.stringify(programs)),
		emittedRanges,
		protectedPrograms,
		counterexamples,
	};
}
