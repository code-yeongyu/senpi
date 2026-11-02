import { readFileSync } from "node:fs";
import { sha256 } from "./scorer.ts";

const paths = [
	"read-folders/brace-scanner.ts",
	"read-folders/compose.ts",
	"read-folders/header-protection.ts",
	"read-folders/lexical-context.ts",
	"read-folders/lexical-spans.ts",
	"read-folders/prepare.ts",
	"read-folders/tree-sitter/engine.ts",
	"read-folders/tree-sitter/grammar-assets.ts",
	"read-folders/tree-sitter/syntax.ts",
	"read-folders/types.ts",
	"segmented-read-view.ts",
] as const;

export function candidateSourceHashes() {
	return Object.fromEntries(
		paths.map((path) => [
			path,
			sha256(readFileSync(new URL(`../../../../src/harness/utils/${path}`, import.meta.url))),
		]),
	);
}
