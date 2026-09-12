import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the devin-agent implementation through a variable specifier so bundlers
 * (browser smoke, Bun compile) cannot follow the import into the Node-only
 * Connect transport. The `.ts`/`.js` rewrite keeps the trick working from both
 * source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

const loadDevinAgentModule = (): Promise<ProviderStreams> =>
	importNodeOnlyApi("./devin-agent.ts") as Promise<ProviderStreams>;

export const devinAgentApi = () => lazyApi(loadDevinAgentModule);
export { loadDevinAgentModule };
