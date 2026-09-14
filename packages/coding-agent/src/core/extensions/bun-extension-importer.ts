import { readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "es-module-lexer/js";
import { ExtensionSourceError } from "./bun-extension-error.ts";
import {
	ExtensionGenerationDisposedError,
	extensionNamespace,
	type ModuleSource,
	registerExtensionGraph,
} from "./bun-extension-registry.ts";

export { bunExtensionImporterStats } from "./bun-extension-registry.ts";

// Keep the source/Node build independent of Bun's ambient type declarations.
declare const Bun: {
	resolveSync(specifier: string, directory: string): string;
	Transpiler: new (options: {
		readonly loader: "ts" | "tsx" | "jsx";
		readonly target: "bun";
		readonly define: Readonly<Record<string, string>>;
	}) => { transformSync(source: string): string };
};

/** A generation owns only source bookkeeping; Bun owns evaluation and cycles. */
export function createBunExtensionImporter(
	virtualModules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
) {
	const sources = new Map<string, ModuleSource>();
	const commonJs = new Set<string>();
	const nativeRequire = createRequire(import.meta.url);
	let active = true;
	const assertActive = () => {
		if (!active) throw new ExtensionGenerationDisposedError(registration.generation);
	};
	const moduleId = (filename: string) =>
		`${extensionNamespace}:${registration.generation}/${encodeURIComponent(filename)}`;
	const graph = {
		assertActive,
		resolve(specifier: string, filename: string): string {
			assertActive();
			if (Object.hasOwn(virtualModules, specifier) || isBuiltin(specifier) || specifier.startsWith("bun:"))
				return specifier;
			if (specifier.startsWith(`${extensionNamespace}:`)) return specifier;
			const path = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
			return moduleId(realpathSync(Bun.resolveSync(path, dirname(filename))));
		},
		require(specifier: string, filename: string): unknown {
			const id = graph.resolve(specifier, filename);
			const result: { readonly default?: unknown } = nativeRequire(id);
			return commonJs.has(id) ? result.default : result;
		},
		load(filename: string): ModuleSource {
			assertActive();
			const existing = sources.get(filename);
			if (existing) return existing;
			const source = readFileSync(filename, "utf8");
			let name = "__senpiExtensionMeta";
			while (source.includes(name)) name += "_";
			const extension = extname(filename);
			const transpiler = new Bun.Transpiler({
				loader: extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : "ts",
				target: "bun",
				define: {
					"import.meta": name,
					require: `${name}.require`,
					__filename: `${name}.path`,
					__dirname: `${name}.dir`,
				},
			});
			let contents: string;
			try {
				contents = transpiler.transformSync(source);
			} catch (error) {
				if (error instanceof AggregateError) throw new ExtensionSourceError(filename, error);
				throw error;
			}
			const [imports, , , hasModuleSyntax] = parse(contents, filename);
			const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
			for (const edge of imports) {
				if (edge.d >= 0) {
					// Replace the keyword, not its argument: nested expressions, templates,
					// import attributes, and unavailable optional dependencies stay lazy.
					edits.push({ start: edge.ss, end: edge.d, text: `${name}.import` });
				} else if (edge.n !== undefined) {
					edits.push({
						start: edge.s - 1,
						end: edge.e + 1,
						text: JSON.stringify(graph.resolve(edge.n, filename)),
					});
				}
			}
			for (const edit of edits.sort((a, b) => b.start - a.start)) {
				contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
			}
			// Runtime plugins load ESM, even for CommonJS source. A local module
			// wrapper preserves synchronous export assignment.
			if (!hasModuleSyntax) {
				commonJs.add(moduleId(filename));
				contents = `const module = { exports: {} }; const exports = module.exports;\n${contents}\nexport default module.exports;`;
			}
			contents = `import { metadata as ${name}Factory } from "${extensionNamespace}:runtime";\nconst ${name} = ${name}Factory(${JSON.stringify(registration.generation)}, ${JSON.stringify(filename)});\n${contents.replace(/^#![^\n]*\n/, "")}`;
			const prepared = { contents, loader: "js" } satisfies ModuleSource;
			sources.set(filename, prepared);
			return prepared;
		},
	};
	const registration = registerExtensionGraph(graph, virtualModules);
	return {
		async import(path: string, _options: { readonly default: true }): Promise<unknown> {
			assertActive();
			const id = moduleId(realpathSync(resolve(path)));
			const module: { readonly default?: unknown } = await import(id);
			const factory = module.default;
			if (typeof factory !== "function") return factory;
			// This wrapper is not stored in Bun's permanent module registry. A
			// reachable old factory keeps its own computed-import graph alive.
			return function (this: unknown, ...args: unknown[]) {
				graph.assertActive();
				return factory.apply(this, args);
			};
		},
		dispose() {
			active = false;
			registration.dispose();
			sources.clear();
			commonJs.clear();
		},
	};
}
