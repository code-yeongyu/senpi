import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the muse-code-cli implementation through a variable specifier so
 * bundlers (browser smoke, Bun compile) cannot follow the import into the
 * Node-only process sidecar. The `.ts`/`.js` rewrite keeps the trick working
 * from both source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<ProviderStreams> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let museCodeCliModuleOverride: ProviderStreams | undefined;

/** Installs the statically bundled implementation in a standalone Bun isolate. */
export function setMuseCodeCliProviderModule(module: ProviderStreams): void {
	museCodeCliModuleOverride = module;
}

const loadMuseCodeCliModule = async (): Promise<ProviderStreams> =>
	museCodeCliModuleOverride ?? importNodeOnlyApi("./muse-code-cli.ts");

export const museCodeCliApi = () => lazyApi(loadMuseCodeCliModule);
export { loadMuseCodeCliModule };
