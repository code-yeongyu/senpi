import { type GrepEngine, GrepEngineError } from "./engine.ts";
import type { NativeGrepLoaderOptions } from "./native-loader.ts";

export type GrepEngineSelectorOptions = NativeGrepLoaderOptions;

let singleton: Promise<GrepEngine> | undefined;

export function resolveGrepEngine(options: GrepEngineSelectorOptions = {}): Promise<GrepEngine> {
	const useSingleton = Object.keys(options).length === 0;
	if (useSingleton && singleton) return singleton;
	const promise = selectEngine(options);
	if (useSingleton) singleton = promise;
	return promise;
}

async function selectEngine(options: GrepEngineSelectorOptions): Promise<GrepEngine> {
	const env = options.env ?? process.env;
	const requested = env.SENPI_GREP_ENGINE ?? "auto";
	if (requested !== "auto" && requested !== "rg" && requested !== "native") {
		throw new GrepEngineError("ENGINE_UNAVAILABLE", `Unknown SENPI_GREP_ENGINE value: ${requested}`);
	}
	if (requested === "rg") return loadRgEngine();
	if (requested === "native") return loadNativeEngine(options, env);
	try {
		return await loadNativeEngine(options, env);
	} catch (error) {
		// ABI mismatch is fatal, not a missing optional addon.
		if (!(error instanceof GrepEngineError) || error.code !== "ENGINE_UNAVAILABLE") throw error;
		console.warn(`[grep] native engine unavailable; falling back to rg: ${error.message}`);
		return loadRgEngine();
	}
}

async function loadRgEngine(): Promise<GrepEngine> {
	const module = await import("./rg-engine.ts");
	return module.createRgEngine();
}

async function loadNativeEngine(options: GrepEngineSelectorOptions, env: NodeJS.ProcessEnv): Promise<GrepEngine> {
	const { loadNativeGrep } = await import("./native-loader.ts");
	const loaded = loadNativeGrep({ ...options, env });
	if (!loaded.native) {
		throw new GrepEngineError("ENGINE_UNAVAILABLE", `${loaded.diagnostic.message} ${loaded.diagnostic.cause}`);
	}
	const { createNativeEngine } = await import("./native-engine.ts");
	return createNativeEngine(loaded.native);
}

export function resetGrepEngineForTests(): void {
	singleton = undefined;
}
