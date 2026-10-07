import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publishRuntimeMetadata } from "./extension-runtime-module.ts";

export type ModuleSource = { readonly contents: string; readonly loader: "js" };
export type Resolution = { readonly path: string; readonly namespace: string };
export type CommonJsModule = { exports: unknown };
export type CommonJsBody = (this: unknown, exports: unknown, module: CommonJsModule) => void;
export interface ExtensionGraph {
	resolve(specifier: string, filename: string): string;
	load(filename: string): ModuleSource;
	require(specifier: string, filename: string): unknown;
	evaluateCommonJs(filename: string, body: CommonJsBody): unknown;
}
type ModuleObject = { readonly exports: Readonly<Record<string, unknown>>; readonly loader: "object" };
declare const Bun: {
	plugin(options: {
		readonly name: string;
		readonly setup: (builder: {
			module(name: string, load: () => ModuleObject): void;
			onResolve(
				options: { readonly filter: RegExp; readonly namespace: string },
				resolve: (args: { readonly path: string }) => Resolution,
			): void;
			onLoad(
				options: { readonly filter: RegExp; readonly namespace: string },
				load: (args: { readonly path: string }) => ModuleSource,
			): void;
		}) => void;
	}): void;
};

// esbuild reads an import() only when its second argument is fully static, and these
// attributes are whatever the extension wrote. The call stays dynamic either way, so
// the importer is built at runtime and the bundler never has to read it.
const importModule = new Function("specifier", "options", "return import(specifier, options)") as (
	specifier: string,
	options?: ImportCallOptions,
) => Promise<unknown>;

export const extensionNamespace = "senpi-extension";
const RUNTIME_SPECIFIER = "runtime";
// Inside a `bun build --compile` binary the shim has no on-disk path (import.meta.url is a
// $bunfs URL), so the file route is only available when the file is really there; the compiled
// binary keeps the virtual module, which it never had a problem with.
const runtimeModulePath = resolveRuntimeModulePath();

function resolveRuntimeModulePath(): string | undefined {
	try {
		const candidate = fileURLToPath(new URL("./extension-runtime-module.js", import.meta.url));
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

// An id is `<generation>/<encodeURIComponent(filename)>`. The encoded half never contains a
// literal "/" (Windows separators arrive as %5C), so the FIRST slash is always the generation
// separator — but only when one exists. A bare id with no slash used to slice to nonsense and
// surface as `Cannot find package '<generation>'` (omo#8427).
function splitModuleId(id: string): { readonly generation: string; readonly filename: string } | undefined {
	const slash = id.indexOf("/");
	if (slash <= 0 || slash === id.length - 1) return undefined;
	return { generation: id.slice(0, slash), filename: decodeURIComponent(id.slice(slash + 1)) };
}
const graphs = new Map<string, WeakRef<ExtensionGraph>>();
const collected = new FinalizationRegistry<string>((generation) => graphs.delete(generation));
let nextGeneration = 0;
let installed = false;
let pluginRegistrations = 0;
const registeredHosts = new Set<string>();

export class ExtensionModuleIdError extends Error {
	readonly name = "ExtensionModuleIdError";
	constructor(id: string) {
		super(`Extension module id is not "<generation>/<encoded filename>": ${id}`);
	}
}

export class ExtensionGenerationDisposedError extends Error {
	readonly name = "ExtensionGenerationDisposedError";
	readonly generation: string;
	constructor(generation: string) {
		super(`Extension generation ${generation} has been disposed`);
		this.generation = generation;
	}
}
function graphFor(generation: string): ExtensionGraph {
	const graph = graphs.get(generation)?.deref();
	if (!graph) throw new ExtensionGenerationDisposedError(generation);
	return graph;
}

// Module-registry exports must never close over a graph: Bun retains modules.
// Only the importer, returned factory wrappers, and live runtimes own graphs.
function metadata(generation: string, filename: string) {
	const resolvePath = (specifier: string) => {
		const id = graphFor(generation).resolve(specifier, filename);
		if (id.startsWith(`${extensionNamespace}:`)) return decodeURIComponent(id.slice(id.indexOf("/") + 1));
		// Files Bun loads natively (JSON, assets) resolve to their real path, not a graph id.
		return isAbsolute(id) ? id : undefined;
	};
	// CommonJS code calls `require.resolve` for sibling files (jsdom locates its XHR sync
	// worker that way), so `require` is a function object carrying Node's resolver shape.
	const require = Object.assign((specifier: string) => graphFor(generation).require(specifier, filename), {
		resolve: (specifier: string) => resolvePath(specifier) ?? graphFor(generation).resolve(specifier, filename),
	});
	return {
		url: pathToFileURL(filename).href,
		path: filename,
		dir: dirname(filename),
		require,
		commonJs: (body: CommonJsBody) => graphFor(generation).evaluateCommonJs(filename, body),
		import: async (specifier: string, options?: ImportCallOptions) =>
			importModule(graphFor(generation).resolve(specifier, filename), options),
		resolve: (specifier: string) => {
			const path = resolvePath(specifier);
			return path === undefined ? graphFor(generation).resolve(specifier, filename) : pathToFileURL(path).href;
		},
	};
}

// A separate activation prevents permanent hooks from sharing a closure
// environment with registerExtensionGraph's disposable graph reference.
function installRegistry(virtualModules: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
	const hosts = Object.entries(virtualModules).filter(([name]) => !registeredHosts.has(name));
	if (!installed || hosts.length > 0) {
		pluginRegistrations++;
		Bun.plugin({
			name: extensionNamespace,
			setup(builder) {
				for (const [name, exports] of hosts) {
					builder.module(name, () => ({ exports, loader: "object" }));
					registeredHosts.add(name);
				}
				if (installed) return;
				// "runtime" resolves to a real file, never a Bun.plugin virtual module. A
				// builder.module() registration is intermittently invisible to the resolver under
				// `bun test --parallel` on a loaded Windows shard: onResolve still fires and returns
				// the namespace, the registration is still listed, and Bun answers
				// `Cannot find package 'runtime'` anyway — generation 1 served 40 resolves and
				// refused the 41st in the same worker (omo#8427, run 35329245740). A file on disk
				// has no registration window to lose.
				publishRuntimeMetadata(metadata);
				builder.module(`${extensionNamespace}:${RUNTIME_SPECIFIER}`, () => ({
					exports: { metadata },
					loader: "object",
				}));
				builder.onResolve({ filter: /.*/, namespace: extensionNamespace }, ({ path }) => {
					if (path === RUNTIME_SPECIFIER)
						return runtimeModulePath === undefined
							? { path, namespace: extensionNamespace }
							: { path: runtimeModulePath, namespace: "file" };
					const parsed = splitModuleId(path);
					if (parsed === undefined) throw new ExtensionModuleIdError(path);
					graphFor(parsed.generation);
					return { path, namespace: extensionNamespace };
				});
				builder.onLoad({ filter: /.*/, namespace: extensionNamespace }, ({ path }) => {
					const parsed = splitModuleId(path);
					if (parsed === undefined) throw new ExtensionModuleIdError(path);
					return graphFor(parsed.generation).load(parsed.filename);
				});
				installed = true;
			},
		});
	}
}

export function registerExtensionGraph(
	graph: ExtensionGraph,
	virtualModules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
) {
	installRegistry(virtualModules);
	const generation = String(nextGeneration++);
	graphs.set(generation, new WeakRef(graph));
	collected.register(graph, generation, graph);
	return {
		generation,
		dispose() {
			graphs.delete(generation);
			collected.unregister(graph);
		},
	};
}

/** Internal lifecycle diagnostics, shared by regression and compiled probes. */
export function bunExtensionImporterStats() {
	return { generations: [...graphs.values()].filter((entry) => entry.deref()).length, plugins: pluginRegistrations };
}
