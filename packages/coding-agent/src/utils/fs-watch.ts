import { type FSWatcher, realpathSync, type WatchListener, type WatchOptions, watch } from "node:fs";
import { opendir } from "node:fs/promises";

export const FS_WATCH_RETRY_DELAY_MS = 5000;

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// Ignore watcher close errors
	}
}

/**
 * The path to hand to `fs.watch`. On Windows libuv aborts the whole process when a directory
 * watch is created through a non-canonical (8.3 short-name) path (issue #1229), so the canonical
 * form is looked up there. Elsewhere the caller's path is used as-is: POSIX realpath opens every
 * directory it resolves, which blocks forever on a wedged autofs trigger, and fs.watch does not
 * need the canonical form on those platforms.
 */
export function canonicalWatchPath(path: string): string {
	if (process.platform !== "win32") return path;
	try {
		return realpathSync.native(path);
	} catch {
		// Keep the raw path when it does not exist yet.
		return path;
	}
}

/**
 * Prove that a directory can be opened before a synchronous `fs.watch` touches it. The watcher
 * opens the directory on the calling thread; on a wedged mount (a macOS autofs trigger whose
 * automounter never answers) that open never returns and would block the host main thread. This
 * probe performs the same open on the async pool, so a caller can bound it with a deadline. It
 * rejects with the open error (for example EACCES on an execute-only directory, which fs.watch
 * would refuse as well).
 */
export async function probeDirectoryOpenable(directory: string): Promise<void> {
	const handle = await opendir(directory);
	try {
		// Bun opens the directory lazily on the first read; Node opens it in opendir itself.
		await handle.read();
	} finally {
		await handle.close();
	}
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
	options?: WatchOptions,
): FSWatcher | null {
	try {
		const watcher = watch(canonicalWatchPath(path), { ...options, encoding: "utf8" }, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
