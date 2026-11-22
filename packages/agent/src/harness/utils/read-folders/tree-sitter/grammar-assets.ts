import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TreeSitterLanguage } from "./syntax.ts";

/** Vendored grammar file names, resolved identically from `src`, published `dist` and the compiled binary. */
export const GRAMMAR_FILES = Object.freeze({
	ts: "typescript.wasm",
	tsx: "tsx.wasm",
	js: "javascript.wasm",
} as const satisfies Record<TreeSitterLanguage, string>);

/** Upstream grammar file names inside the pinned measurement dependency. */
const UPSTREAM_FILES = Object.freeze({
	ts: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	js: "tree-sitter-javascript.wasm",
} as const satisfies Record<TreeSitterLanguage, string>);

export const TREE_SITTER_RUNTIME_FILE = "web-tree-sitter.wasm";

/** `src/harness/utils/read-folders/tree-sitter` and `dist/harness/utils/read-folders/tree-sitter` share this depth. */
export const packagedAssetDirectory = fileURLToPath(new URL("../../../../../assets/tree-sitter/", import.meta.url));

/**
 * Bun's compiler embeds a literal `type: "file"` import and hands back an extracted path.
 * Only shipped grammars may appear here: every specifier must resolve at compile time.
 */
const embeddedGrammars: Partial<Record<TreeSitterLanguage, () => Promise<{ default: string }>>> = {
	js: () => import("../../../../../assets/tree-sitter/javascript.wasm", { with: { type: "file" } }),
};
const embeddedRuntime = () =>
	import("../../../../../assets/tree-sitter/web-tree-sitter.wasm", { with: { type: "file" } });

async function embeddedPath(load: (() => Promise<{ default: string }>) | undefined): Promise<string | undefined> {
	if (!load) return undefined;
	try {
		const module = await load();
		return existsSync(module.default) ? module.default : undefined;
	} catch {
		return undefined;
	}
}

function installedPath(specifier: string): string | undefined {
	try {
		const path = createRequire(import.meta.url).resolve(specifier);
		return existsSync(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

export type GrammarResolver = (language: TreeSitterLanguage) => Promise<string | undefined>;

/**
 * Packaged grammars ship with the package and the compiled binary; the pinned measurement
 * dependency only backs languages that are evaluated but not shipped. A missing grammar is a
 * normal outcome: the caller keeps the heuristic folder.
 */
export async function resolveGrammarPath(language: TreeSitterLanguage): Promise<string | undefined> {
	const packaged = join(packagedAssetDirectory, GRAMMAR_FILES[language]);
	if (existsSync(packaged)) return packaged;
	return (
		(await embeddedPath(embeddedGrammars[language])) ??
		installedPath(`@vscode/tree-sitter-wasm/wasm/${UPSTREAM_FILES[language]}`)
	);
}

/** The emscripten runtime module the grammars are instantiated against. */
export async function resolveRuntimePath(): Promise<string | undefined> {
	const packaged = join(packagedAssetDirectory, TREE_SITTER_RUNTIME_FILE);
	if (existsSync(packaged)) return packaged;
	return (await embeddedPath(embeddedRuntime)) ?? installedPath("web-tree-sitter/web-tree-sitter.wasm");
}
