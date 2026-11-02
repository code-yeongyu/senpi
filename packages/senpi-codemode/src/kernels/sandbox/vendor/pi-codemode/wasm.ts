// Vendored from https://github.com/earendil-works/pi (packages/codemode/src) at v1.0.1, commit a7229ddc21810d6245105978033b7df645ecc2f7.
// MIT license; see LICENSE beside this file. Local changes are listed in VENDORED.md.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * A compiled `WebAssembly.Module` of `quickjs-wasi/quickjs.wasm`. Typed opaquely because the Node
 * type definitions do not declare the WebAssembly globals (they live in the DOM lib).
 */
export type CodemodeWasmModule = object;

interface WebAssemblyGlobal {
	compile(bytes: Uint8Array): Promise<CodemodeWasmModule>;
}

const modules = new Map<string, Promise<CodemodeWasmModule>>();

/**
 * Read and compile the QuickJS wasm once per path. `path` defaults to the file in the installed
 * `quickjs-wasi` package; pass it when that file lives elsewhere, for example embedded in a Bun
 * compiled executable. A failed load is retried on the next call.
 */
export function loadQuickJSWasm(path?: string): Promise<CodemodeWasmModule> {
	const resolved = path ?? createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	let module = modules.get(resolved);
	if (!module) {
		const { WebAssembly } = globalThis as unknown as { WebAssembly: WebAssemblyGlobal };
		module = readFile(resolved)
			.then((bytes) => WebAssembly.compile(bytes))
			.catch((error: unknown) => {
				modules.delete(resolved);
				throw error;
			});
		modules.set(resolved, module);
	}
	return module;
}
