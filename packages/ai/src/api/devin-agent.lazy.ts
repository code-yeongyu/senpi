import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the devin-agent implementation through a variable specifier so bundlers
 * (browser smoke, Bun compile) cannot follow the import into the Node-only
 * Connect transport. The `.ts`/`.js` rewrite keeps the trick working from both
 * source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<ProviderStreams> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let devinAgentModuleOverride: ProviderStreams | undefined;

/** Installs the statically bundled implementation in a standalone Bun isolate. */
export function setDevinAgentProviderModule(module: ProviderStreams): void {
	devinAgentModuleOverride = module;
}

const loadDevinAgentModule = async (): Promise<ProviderStreams> =>
	devinAgentModuleOverride ?? importNodeOnlyApi("./devin-agent.ts");

export const devinAgentApi = () => lazyApi(loadDevinAgentModule);
export { loadDevinAgentModule };
