import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { BridgeConnectionConfig } from "../../bridge/protocol.ts";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL } from "../../bridge/reserved.ts";
import type { JavaScriptKernelOptions as BaseJavaScriptKernelOptions } from "./kernel-contract.ts";
import { rewriteImports } from "./rewrite-imports.ts";

const PREPARED_CELL_PREFIX = "/*senpi:prepared-cell*/";

export interface LocalModuleLoaderOptions {
	readonly cwd: string;
	readonly localRoots?: Readonly<Record<string, string>>;
	readonly artifactsDir?: string;
}

export type JavaScriptKernelOptions = BaseJavaScriptKernelOptions & LocalModuleLoaderOptions;

export function localBridgeConnection(options: LocalModuleLoaderOptions): BridgeConnectionConfig {
	return {
		port: 1,
		token: "local",
		...(options.localRoots ? { localRoots: { ...options.localRoots } } : {}),
		...(options.artifactsDir ? { artifactsDir: options.artifactsDir } : {}),
	};
}

type RuntimeModuleContext = {
	readonly cwdUrl: string;
	readonly localRootUrls: Readonly<Record<string, string>>;
	readonly reservedAgentTool: string;
	readonly reservedOutputTool: string;
};

function directoryUrl(directory: string): string {
	return pathToFileURL(`${resolve(directory)}${sep}`).href;
}

function runtimeContext(options: LocalModuleLoaderOptions): RuntimeModuleContext {
	const roots: Record<string, string> = {};
	for (const [scheme, root] of Object.entries(options.localRoots ?? {})) {
		roots[scheme.toLowerCase()] = directoryUrl(root);
	}
	if (options.artifactsDir && roots["local"] === undefined) {
		roots["local"] = directoryUrl(join(options.artifactsDir, "local"));
	}
	return {
		cwdUrl: directoryUrl(options.cwd),
		localRootUrls: roots,
		reservedAgentTool: RESERVED_AGENT_TOOL,
		reservedOutputTool: RESERVED_OUTPUT_TOOL,
	};
}

function loaderPrelude(context: RuntimeModuleContext): string {
	const serialized = JSON.stringify(context);
	return [
		`globalThis.__senpi_module_context__ = ${serialized};`,
		"globalThis.__senpi_reserved_agent_tool__ = globalThis.__senpi_module_context__.reservedAgentTool;",
		"globalThis.__senpi_reserved_output_tool__ = globalThis.__senpi_module_context__.reservedOutputTool;",
		"globalThis.__senpi_import__ = async (source, options) => {",
		"  const context = globalThis.__senpi_module_context__;",
		"  const specifier = String(source);",
		"  const match = /^([a-z][a-z0-9+.-]*):\\/\\/(.*)$/i.exec(specifier);",
		"  let target = specifier;",
		"  if (match) {",
		"    const scheme = match[1].toLowerCase();",
		"    const root = context.localRootUrls[scheme];",
		"    if (!root) throw new Error('Unsupported module protocol: ' + specifier);",
		"    let relative;",
		"    try { relative = decodeURIComponent(match[2].replaceAll('\\\\', '/')); }",
		"    catch { throw new Error('Invalid module URL encoding: ' + specifier); }",
		"    if (relative.startsWith('/') || relative.split('/').includes('..')) {",
		"      throw new Error('Module path escapes ' + scheme + ':// root: ' + specifier);",
		"    }",
		"    target = new URL(relative, root).href;",
		"  } else if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {",
		"    target = new URL(specifier, context.cwdUrl).href;",
		"  } else if (specifier.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(specifier)) {",
		"    const urlModule = await import('node:url');",
		"    target = urlModule.pathToFileURL(specifier).href;",
		"  }",
		"  return options === undefined ? import(target) : import(target, options);",
		"};",
	].join("\n");
}

export class LocalModuleLoader {
	readonly #prelude: string;

	constructor(options: LocalModuleLoaderOptions) {
		this.#prelude = loaderPrelude(runtimeContext(options));
	}

	prepareCell(code: string): string {
		return `${PREPARED_CELL_PREFIX}${JSON.stringify({ prelude: this.#prelude, code: rewriteImports(code) })}`;
	}
}
