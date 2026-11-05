import { pathToFileURL } from "node:url";

const sourceResolverUrl = pathToFileURL(
	new URL("../../src/experimental/source-resolver.ts", import.meta.url).pathname,
).href;

/**
 * Runtime flags for a child that runs the CLI from its .ts sources with this process's runtime. Node needs the source
 * resolver (its loader for .ts); Bun runs TypeScript natively and has no `registerHooks`, so it gets none.
 */
export function sourceRuntimeArgs(): string[] {
	return process.versions.bun === undefined ? ["--import", sourceResolverUrl] : [];
}
