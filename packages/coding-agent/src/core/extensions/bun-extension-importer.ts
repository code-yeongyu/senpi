import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "es-module-lexer/js";
import {
	isCommonJsFile,
	isEsmByPackageType,
	parseImportClause,
	rewriteCommonJsImport,
} from "./bun-extension-commonjs.ts";
import { ExtensionSourceError } from "./bun-extension-error.ts";
import { createPreparedSourceCache, type PreparedEdge, type PreparedSource } from "./bun-extension-prepared-cache.ts";
import {
	type CommonJsBody,
	type CommonJsModule,
	ExtensionGenerationDisposedError,
	extensionNamespace,
	type ModuleSource,
	registerExtensionGraph,
	runtimeModulePath,
} from "./bun-extension-registry.ts";
import { hasUseStrictDirective, strictDirectiveModuleSource } from "./bun-extension-strict-directive.ts";

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
	builtinRedirects: Readonly<Record<string, string>> = {},
	options: { readonly preparedCache?: { readonly dir: string; readonly release: string } } = {},
) {
	// The key names everything that shapes prepared bytes, so a change to any of it never reads an old entry.
	// `release` (the senpi version) covers what changes only with a release, such as the lexer package; the
	// sources of this importer, the CommonJS rewrite and the whole strict-directive module cover an edit to this
	// code between releases.
	const preparedCache =
		options.preparedCache === undefined
			? undefined
			: createPreparedSourceCache(options.preparedCache.dir, [
					"2",
					options.preparedCache.release,
					process.versions.bun ?? "",
					runtimeModulePath ?? "virtual",
					extensionNamespace,
					createBunExtensionImporter.toString(),
					rewriteCommonJsImport.toString(),
					parseImportClause.toString(),
					strictDirectiveModuleSource,
					parse.toString(),
				]);
	const sources = new Map<string, ModuleSource>();
	const fingerprints = new Map<string, string>();
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
	const moduleId = (filename: string, generation = registration.generation) =>
		`${extensionNamespace}:${generation}/${encodeURIComponent(filename)}`;
	// Only source the graph transpiles gets a graph id. Anything else (JSON, TOML, text, native
	// addons) keeps its real path so Bun's own loader handles it: Bun 1.3.x cannot follow a
	// plugin's hand-back to the `file` namespace from a runtime import() or require() (#2164).
	const fileTarget = (resolved: string, generation?: string): { readonly id: string; readonly path?: string } =>
		/\.[cm]?[jt]sx?$/.test(resolved) ? { id: moduleId(resolved, generation), path: resolved } : { id: resolved };
	const resolveTarget = (
		specifier: string,
		filename: string,
		generation?: string,
	): { readonly id: string; readonly path?: string } => {
		assertActive();
		// Own keys only: a package named after an Object.prototype key ("constructor") is not a redirect.
		const redirect = Object.hasOwn(builtinRedirects, specifier) ? builtinRedirects[specifier] : undefined;
		if (redirect !== undefined) return { id: redirect };
		if (Object.hasOwn(virtualModules, specifier) || isBuiltin(specifier) || specifier.startsWith("bun:"))
			return { id: specifier };
		if (specifier.startsWith(`${extensionNamespace}:`)) return { id: specifier };
		const path = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
		return fileTarget(realpathSync(Bun.resolveSync(path, dirname(filename))), generation);
	};
	const resolveEdge = (specifier: string, filename: string, generation: string): PreparedEdge => {
		const target = resolveTarget(specifier, filename, generation);
		return { specifier, id: target.id, commonJs: target.path !== undefined && isCommonJsFile(target.path) };
	};
	// The prepared bytes bake in these resolutions, so a cached entry is only as good as they still are.
	const edgesStillResolve = (edges: readonly PreparedEdge[], filename: string, generation: string) =>
		edges.every((edge) => {
			const now = resolveEdge(edge.specifier, filename, generation);
			return now.id === edge.id && now.commonJs === edge.commonJs;
		});
	// Prepares with `token` standing in for the generation, so the result is generation-independent.
	const prepare = (source: string, filename: string, token: string, name: string, esmByType: boolean) => {
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
		const edges: PreparedEdge[] = [];
		for (const edge of imports) {
			if (edge.type === "dynamic") {
				// Replace the keyword, not its argument: nested expressions, templates,
				// import attributes, and unavailable optional dependencies stay lazy.
				edits.push({ start: edge.importStart, end: edge.dynamicStart, text: `${name}.import` });
			} else if (edge.type === "static" || edge.type === "reexport-star") {
				const target = resolveEdge(edge.specifier, filename, token);
				edges.push(target);
				if (target.commonJs) {
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
		const isCommonJs = !hasModuleSyntax && extension !== ".mjs" && extension !== ".mts" && !esmByType;
		if (isCommonJs) {
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
		// Bun <= 1.4.2 bakes the resolved runtime path into its transpile cache, keyed by this source; naming
		// the path re-keys the cache when an update moves the runtime and heals entries an older runtime
		// baked before the prune (senpi#3300). Same line, so diagnostics keep their line numbers.
		contents = `import { metadata as ${name}Factory } from "${extensionNamespace}:runtime"; // runtime ${runtimeModulePath === undefined ? "virtual" : encodeURI(runtimeModulePath)}\nconst ${name} = ${name}Factory(${JSON.stringify(token)}, ${JSON.stringify(filename)});\n${contents}`;
		return { token, contents, commonJs: isCommonJs, esmByType, edges } satisfies PreparedSource;
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
			const fingerprint = createHash("sha256").update(source).digest("hex");
			let name = "__senpiExtensionMeta";
			while (source.includes(name) || filename.includes(name)) name += "_";
			// The token is replaced across the prepared bytes. The source and this raw filename (header, sourceURL)
			// never contain `name`; the only other raw text is the real path of an imported JSON or native file,
			// which would have to contain `${name}:generation` to collide.
			const token = `${name}:generation`;
			const esmByType = extname(filename) === ".js" && isEsmByPackageType(filename);
			const cached = preparedCache?.read(filename, fingerprint);
			let ready =
				cached?.token === token &&
				cached.esmByType === esmByType &&
				edgesStillResolve(cached.edges, filename, token)
					? cached
					: undefined;
			if (ready === undefined) {
				ready = prepare(source, filename, token, name, esmByType);
				preparedCache?.write(filename, fingerprint, ready);
			}
			if (ready.commonJs) commonJs.add(moduleId(filename));
			const contents = ready.contents.replaceAll(token, registration.generation);
			const prepared = { contents, loader: "js" } satisfies ModuleSource;
			sources.set(filename, prepared);
			fingerprints.set(filename, fingerprint);
			return prepared;
		},
	};
	const registration = registerExtensionGraph(graph, virtualModules);
	return {
		async import(path: string, _options: { readonly default: true }): Promise<unknown> {
			assertActive();
			const absolute = realpathSync(resolve(path));
			// A package directory loads through its main or index file, as a native import does.
			const entry = statSync(absolute).isDirectory() ? realpathSync(Bun.resolveSync(absolute, absolute)) : absolute;
			const { id } = fileTarget(entry);
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
		/** The whole module namespace (a tool child's `module` job calls a named export, senpi#3566). */
		async importNamespace(path: string): Promise<Record<string, unknown>> {
			assertActive();
			const { id } = fileTarget(realpathSync(resolve(path)));
			return import(id);
		},
		// Capture identity from the transpiler input, never from a later disk snapshot.
		compiledSources(): ReadonlyMap<string, string> {
			return fingerprints;
		},
		dispose() {
			active = false;
			registration.dispose();
			sources.clear();
			fingerprints.clear();
			commonJs.clear();
			commonJsModules.clear();
		},
	};
}
