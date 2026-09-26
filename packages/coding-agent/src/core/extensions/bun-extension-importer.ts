import { readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "es-module-lexer/js";
import { isCommonJsFile, isEsmByPackageType, rewriteCommonJsImport } from "./bun-extension-commonjs.ts";
import { ExtensionSourceError } from "./bun-extension-error.ts";
import {
	type CommonJsBody,
	type CommonJsModule,
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

function skipTrivia(source: string, index: number): { readonly index: number; readonly hasLineTerminator: boolean } {
	let hasLineTerminator = false;
	while (index < source.length) {
		const char = source[index];
		if (char === "\r" || char === "\n" || char === "\u2028" || char === "\u2029") {
			hasLineTerminator = true;
			index += 1;
			continue;
		}
		if (char !== undefined && /\s/u.test(char)) {
			index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			index += 2;
			while (index < source.length && !/[\r\n\u2028\u2029]/u.test(source[index] ?? "")) index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			index += 2;
			while (index < source.length) {
				const commentChar = source[index];
				if (commentChar === "\r" || commentChar === "\n" || commentChar === "\u2028" || commentChar === "\u2029")
					hasLineTerminator = true;
				if (commentChar === "*" && source[index + 1] === "/") {
					index += 2;
					break;
				}
				index += 1;
			}
			continue;
		}
		break;
	}
	return { index, hasLineTerminator };
}

function stringLiteralEnd(source: string, index: number): number | undefined {
	const quote = source[index];
	if (quote !== '"' && quote !== "'") return undefined;
	for (index += 1; index < source.length; index += 1) {
		const char = source[index];
		if (char === "\\") {
			index += 1;
			if (source[index] === "\r" && source[index + 1] === "\n") index += 1;
			continue;
		}
		if (char === quote) return index + 1;
		if (char === "\r" || char === "\n") return undefined;
	}
	return undefined;
}

function isStringExpressionContinuation(source: string, index: number): boolean {
	const char = source[index];
	if (char === undefined) return false;
	if (char === "+" || char === "-") return source[index + 1] !== char;
	if (char === "!") return source[index + 1] === "=";
	if ("([.`?*/%&|^<>=,:".includes(char)) return true;
	return /^(?:in|instanceof)(?![$_\p{ID_Continue}\\\u200c\u200d])/u.test(source.slice(index));
}

/** Whether the original CommonJS source opts into strict mode with a directive prologue. */
function hasUseStrictDirective(source: string): boolean {
	let index = 0;
	if (source.startsWith("#!")) {
		const lineEnd = source.indexOf("\n");
		index = lineEnd === -1 ? source.length : lineEnd + 1;
	}
	for (;;) {
		index = skipTrivia(source, index).index;
		const start = index;
		const end = stringLiteralEnd(source, index);
		if (end === undefined) return false;
		const strict = source.slice(start, end) === '"use strict"' || source.slice(start, end) === "'use strict'";
		const after = skipTrivia(source, end);
		if (source[after.index] === ";") {
			if (strict) return true;
			index = after.index + 1;
			continue;
		}
		if (strict && (after.index === source.length || source[after.index] === "}")) return true;
		if (strict && after.hasLineTerminator && !isStringExpressionContinuation(source, after.index)) return true;
		if (!after.hasLineTerminator || (source[after.index] !== '"' && source[after.index] !== "'")) return false;
		index = after.index;
	}
}

/** A generation owns only source bookkeeping; Bun owns evaluation and cycles. */
export function createBunExtensionImporter(
	virtualModules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
) {
	const sources = new Map<string, ModuleSource>();
	const commonJs = new Set<string>();
	// Live `module` objects by id, registered while a CommonJS body runs: a require inside a
	// cycle receives the partially built exports, as in Node, instead of an unset ESM default.
	// A body that throws is evicted so a later require re-throws instead of seeing a half-built module.
	const commonJsModules = new Map<string, CommonJsModule>();
	const nativeRequire = createRequire(import.meta.url);
	let active = true;
	const assertActive = () => {
		if (!active) throw new ExtensionGenerationDisposedError(registration.generation);
	};
	const moduleId = (filename: string) =>
		`${extensionNamespace}:${registration.generation}/${encodeURIComponent(filename)}`;
	const resolveTarget = (specifier: string, filename: string): { readonly id: string; readonly path?: string } => {
		assertActive();
		if (Object.hasOwn(virtualModules, specifier) || isBuiltin(specifier) || specifier.startsWith("bun:"))
			return { id: specifier };
		if (specifier.startsWith(`${extensionNamespace}:`)) return { id: specifier };
		const path = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
		const resolved = realpathSync(Bun.resolveSync(path, dirname(filename)));
		return { id: moduleId(resolved), path: resolved };
	};
	const graph = {
		assertActive,
		resolve(specifier: string, filename: string): string {
			return resolveTarget(specifier, filename).id;
		},
		require(specifier: string, filename: string): unknown {
			const id = graph.resolve(specifier, filename);
			const evaluating = commonJsModules.get(id);
			if (evaluating !== undefined) return evaluating.exports;
			const result: { readonly default?: unknown } = nativeRequire(id);
			return commonJs.has(id) ? result.default : result;
		},
		evaluateCommonJs(filename: string, body: CommonJsBody): unknown {
			assertActive();
			const id = moduleId(filename);
			const module: CommonJsModule = { exports: {} };
			commonJsModules.set(id, module);
			try {
				body.call(module.exports, module.exports, module);
			} catch (error) {
				commonJsModules.delete(id);
				throw error;
			}
			return module.exports;
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
			let commonJsImports = 0;
			for (const edge of imports) {
				if (edge.type === "dynamic") {
					// Replace the keyword, not its argument: nested expressions, templates,
					// import attributes, and unavailable optional dependencies stay lazy.
					edits.push({ start: edge.importStart, end: edge.dynamicStart, text: `${name}.import` });
				} else if (edge.type === "static" || edge.type === "reexport-star") {
					const target = resolveTarget(edge.specifier, filename);
					if (target.path !== undefined && isCommonJsFile(target.path)) {
						// "import" and "export" are both six characters, so the clause is
						// whatever sits between the keyword and the specifier in either form.
						const clause = contents
							.slice(edge.importStart + "import".length, edge.start - 1)
							.replace(/\bfrom\s*$/, "");
						// This branch replaces the whole statement, so the attributes between the
						// specifier and the end of it have to travel with it: they pick the loader.
						const attributes =
							edge.attributesStart < 0 ? "" : contents.slice(edge.end + 1, edge.importEnd).replace(/;\s*$/, "");
						edits.push({
							start: edge.importStart,
							end: edge.importEnd,
							text: rewriteCommonJsImport(clause, target.id, `${name}Cjs${commonJsImports++}`, attributes),
						});
					} else {
						edits.push({ start: edge.start - 1, end: edge.end + 1, text: JSON.stringify(target.id) });
					}
				}
			}
			for (const edit of edits.sort((a, b) => b.start - a.start)) {
				contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
			}
			// A shebang is only a shebang on the first line, so it goes before any prologue.
			contents = contents.replace(/^#![^\n]*\n/, "");
			// Runtime plugins load ESM, even for CommonJS source. Node's module
			// function wrapper preserves synchronous export assignment and keeps
			// `exports` and `module` reassignable bindings with `this` as the exports
			// object, as dependencies such as whatwg-url and jsdom require.
			// `.cjs` is always CommonJS; a `.js` file whose nearest package.json declares
			// `"type": "module"` is ESM even with no import/export, so top-level await parses.
			const esmByType = extension === ".js" && isEsmByPackageType(filename);
			if (!hasModuleSyntax && extension !== ".mjs" && extension !== ".mts" && !esmByType) {
				commonJs.add(moduleId(filename));
				// The body is compiled with the Function constructor rather than emitted as a
				// function literal in this ES module: a literal would inherit the module's strict
				// mode, while Node and plain Bun evaluate CommonJS sloppy unless the file opts in.
				// The metadata object arrives as a parameter, so the transformed body keeps the
				// identifiers the transpiler already bound, and `//# sourceURL` keeps stack frames
				// on the dependency file.
				// Bun's transpiler drops a leading "use strict" directive, so opting in has to be
				// read from the original source and re-applied to the compiled body.
				const directive = hasUseStrictDirective(source) ? '"use strict";\n' : "";
				const body = `${directive}${contents}\n//# sourceURL=${pathToFileURL(filename).href}`;
				// The compiled body takes the metadata first; the forwarding wrapper keeps Node's
				// `this === module.exports` receiver, which dependencies such as whatwg-url rely on.
				contents = [
					`const ${name}Body = Function(${JSON.stringify(name)}, "exports", "module", ${JSON.stringify(body)});`,
					`export default ${name}.commonJs(function (exports, module) {`,
					`\treturn ${name}Body.call(this, ${name}, exports, module);`,
					"});",
				].join("\n");
			}
			contents = `import { metadata as ${name}Factory } from "${extensionNamespace}:runtime";\nconst ${name} = ${name}Factory(${JSON.stringify(registration.generation)}, ${JSON.stringify(filename)});\n${contents}`;
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
		// The generation's staleness check reads these: every source file it transpiled.
		compiledFiles(): readonly string[] {
			return [...sources.keys()];
		},
		dispose() {
			active = false;
			registration.dispose();
			sources.clear();
			commonJs.clear();
			commonJsModules.clear();
		},
	};
}
