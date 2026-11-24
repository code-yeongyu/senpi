import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
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
//
// Such a call can still defeat one delete of the renamed tree. A temporary file renamed over its entry
// while the delete walks the tree makes the walk's unlink of it fail with ENOENT, and Node 24's rmSync reads
// that as "the path is already gone": it returns without an error or a retry and leaves the tree behind
// (senpi#5678). A file created after the walk fails the final rmdir with ENOTEMPTY instead. So the delete
// runs again whenever a pass ends with the tree still there; every such pass is caused by a call that was
// already in flight at the rename, those calls are finite, and a pass that finds the tree settled removes
// it. The bound turns a tree that something keeps writing into into a clear error instead of a hung run.
const DELETE_PASSES = 100;

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
	let lastPass: Error | undefined;
	for (let pass = 1; existsSync(removing); pass += 1) {
		if (pass > DELETE_PASSES) {
			const last = lastPass?.message ?? "returned with the directory still there";
			throw new Error(`${removing} was still there after ${DELETE_PASSES} delete passes; last pass: ${last}`, {
				cause: lastPass,
			});
		}
		lastPass = undefined;
		try {
			deleteTree(removing);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOTEMPTY") throw error;
			lastPass = error;
		}
	}
}
