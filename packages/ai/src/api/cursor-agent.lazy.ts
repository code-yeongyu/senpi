import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the cursor-agent implementation through a variable specifier so
 * bundlers (browser smoke, Bun compile) cannot follow the import into the
 * Node-only HTTP/2 transport. The `.ts`/`.js` rewrite keeps the trick working
 * from both source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

type CursorAgentModule = ProviderStreams & {
	fetchCursorUsableModels: (options: {
		apiKey: string;
		baseUrl?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	}) => Promise<
		| {
				id: string;
				name: string;
				reasoning: boolean;
				input: ("text" | "image")[];
				contextWindow: number;
				maxTokens: number;
				cursorMaxMode: boolean;
		  }[]
		| null
	>;
};

let cursorAgentModuleOverride: CursorAgentModule | undefined;

/**
 * Overrides the dynamically imported cursor-agent implementation. Used by the
 * Bun binary build, where the variable-specifier import cannot be bundled;
 * the build registers a statically imported module instead.
 */
export function setCursorAgentProviderModule(module: CursorAgentModule): void {
	cursorAgentModuleOverride = module;
}

/** Loads the Node-only cursor-agent module (stream + model discovery). */
export const loadCursorAgentModule = async (): Promise<CursorAgentModule> =>
	cursorAgentModuleOverride ?? ((await importNodeOnlyApi("./cursor-agent.ts")) as CursorAgentModule);

/** Lazy wrapper: keeps the Node-only Cursor agent transport out of eager import graphs. */
export const cursorAgentApi = (): ProviderStreams => lazyApi(loadCursorAgentModule);
