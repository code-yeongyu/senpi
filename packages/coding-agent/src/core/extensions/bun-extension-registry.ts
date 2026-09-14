import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export type ModuleSource = { readonly contents: string; readonly loader: "js" };
export type Resolution = { readonly path: string; readonly namespace: string };
export interface ExtensionGraph {
	resolve(specifier: string, filename: string): string;
	load(filename: string): ModuleSource;
	require(specifier: string, filename: string): unknown;
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

export const extensionNamespace = "senpi-extension";
const graphs = new Map<string, WeakRef<ExtensionGraph>>();
const collected = new FinalizationRegistry<string>((generation) => graphs.delete(generation));
let nextGeneration = 0;
let installed = false;
let pluginRegistrations = 0;
const registeredHosts = new Set<string>();

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
	return {
		url: pathToFileURL(filename).href,
		path: filename,
		dir: dirname(filename),
		require: (specifier: string) => graphFor(generation).require(specifier, filename),
		import: async (specifier: string, options?: ImportCallOptions) =>
			import(graphFor(generation).resolve(specifier, filename), { ...options }),
		resolve: (specifier: string) => {
			const id = graphFor(generation).resolve(specifier, filename);
			return id.startsWith(`${extensionNamespace}:`)
				? pathToFileURL(decodeURIComponent(id.slice(id.indexOf("/") + 1))).href
				: id;
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
				builder.module(`${extensionNamespace}:runtime`, () => ({ exports: { metadata }, loader: "object" }));
				builder.onResolve({ filter: /.*/, namespace: extensionNamespace }, ({ path }) => {
					if (path === "runtime") return { path, namespace: extensionNamespace };
					const slash = path.indexOf("/");
					graphFor(path.slice(0, slash));
					const filename = decodeURIComponent(path.slice(slash + 1));
					return /\.[cm]?[jt]sx?$/.test(filename)
						? { path, namespace: extensionNamespace }
						: { path: filename, namespace: "file" };
				});
				builder.onLoad({ filter: /.*/, namespace: extensionNamespace }, ({ path }) => {
					const slash = path.indexOf("/");
					return graphFor(path.slice(0, slash)).load(decodeURIComponent(path.slice(slash + 1)));
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
