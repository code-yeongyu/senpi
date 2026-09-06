import { type FSWatcher, realpathSync, type WatchListener, type WatchOptions, watch } from "node:fs";

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

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
	options?: WatchOptions,
): FSWatcher | null {
	try {
		let watchPath = path;
		if (process.platform === "win32") {
			try {
				watchPath = realpathSync.native(path);
			} catch {
				// Keep the raw path when it does not exist yet.
			}
		}
		const watcher = watch(watchPath, { ...options, encoding: "utf8" }, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
