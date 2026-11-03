import { mkdtempSync, renameSync, rmSync } from "node:fs";
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
		removeRunDirectory(directory);
	};
}

// Source processes a run launched can outlive it: experimental coordinators and session workers are
// detached and retire on their own grace timers, and Node writes a process's compile cache when it exits
// (a temporary file created in the cache directory, then renamed over the entry). Deleting the directory
// in place races those writes: an entry created between the walk and the final rmdir fails the delete
// with ENOTEMPTY and turns a passing run into exit 1 (senpi#5370). Renaming the directory first takes it
// away from every writer, because each write resolves the original path again: a later write finds no
// directory and Node drops it as a cache miss. Only a call already past its path lookup when the rename
// lands can still add an entry to the renamed tree, and no new call can reach it.
export function removeRunDirectory(
	directory: string,
	deleteTree: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true, maxRetries: 3 }),
): void {
	const removing = `${directory}-removing`;
	try {
		renameSync(directory, removing);
	} catch {
		// Windows refuses to rename a directory while a file in it is open; delete in place as before.
		rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
		return;
	}
	deleteTree(removing);
}
