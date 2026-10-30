import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_COMPILE_CACHE_ENV } from "../../src/experimental/source-compile-cache.ts";

// Vitest runs this once in its main process before the worker forks start, so the directory reaches every
// worker and the source processes they launch (`node --import source-resolver.ts <entry>.ts`). One run,
// one directory: a child entry launched again reuses the earlier launch's type-strip and compile work
// instead of redoing it for its whole module graph (senpi#4614). A caller that already named a
// directory keeps it.
export default function setup(): (() => void) | undefined {
	if (process.env[SOURCE_COMPILE_CACHE_ENV] !== undefined) return undefined;
	const directory = mkdtempSync(join(tmpdir(), "senpi-source-compile-cache-"));
	process.env[SOURCE_COMPILE_CACHE_ENV] = directory;
	return () => {
		delete process.env[SOURCE_COMPILE_CACHE_ENV];
		rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
	};
}
