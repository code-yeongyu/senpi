import * as nodeModule from "node:module";

/** Directory of the compile cache shared by the source processes one test run launches (senpi#4614). */
export const SOURCE_COMPILE_CACHE_ENV = "SENPI_SOURCE_COMPILE_CACHE";

// Without a cache every source process type-strips and compiles its whole workspace graph again (the faux
// session worker: 1,700 modules, 527 of them TypeScript). Node's compile cache keys entries by source
// content and also stores the strip result, so a repeated launch reuses that work while an edited file is
// still recompiled. The cache stays opt-in: only a run that names its own directory (the coding-agent
// vitest globalSetup) enables it, so a plain source launch keeps today's behavior and a developer can turn
// it off for a run with NODE_DISABLE_COMPILE_CACHE=1. The API is read off the namespace like
// compile-cache.ts does, so a runtime without it links this module unchanged.
export function enableSourceCompileCache(): void {
	const directory = process.env[SOURCE_COMPILE_CACHE_ENV];
	if (directory === undefined || directory === "") return;
	const enable = (nodeModule as Partial<typeof nodeModule>).enableCompileCache;
	if (typeof enable !== "function") return;
	enable(directory);
}
