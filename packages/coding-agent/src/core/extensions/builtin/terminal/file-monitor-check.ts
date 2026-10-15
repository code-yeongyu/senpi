/**
 * One check pass of a file watch: re-prove the target's identity (no symlink, the same inode, the
 * parent unchanged) without blocking on open(2), digest it, and decide whether the watched event
 * happened. The watch settles on a failed proof and fires (then completes) on its event.
 */
import { type FileHandle, lstat, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import type { FileMonitorRecord } from "./file-monitor-record.ts";
import { digestFileHandle } from "./monitor-file-digest.ts";

export interface FileCheckActions {
	/** Ends the watch with this summary. */
	settle(summary: string): void;
	/** The watched event happened: emit this line, then complete the watch. */
	fire(line: string): void;
}

export async function checkFileOnce(record: FileMonitorRecord, actions: FileCheckActions): Promise<void> {
	if (record.settled) return;
	let current: Awaited<ReturnType<typeof stat>> | null = null;
	let handle: FileHandle | undefined;
	try {
		const currentParent = realpathWithoutOpen(dirname(record.path));
		if (currentParent !== record.canonicalParent) {
			actions.settle(`watcher error: monitored parent changed: ${dirname(record.path)}`);
			return;
		}
		const target = await lstat(record.canonicalPath);
		if (target.isSymbolicLink()) throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
		const resolvedTarget = realpathWithoutOpen(record.canonicalPath);
		if (resolvedTarget !== record.canonicalPath)
			throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
		handle = await open(record.canonicalPath, "r");
		const opened = await handle.stat();
		if (!opened.isFile()) throw new Error(`Cannot watch file: target is not a regular file: ${record.path}`);
		if ((opened.dev !== record.device || opened.ino !== record.inode) && opened.nlink > 1)
			throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
		current = opened;
		const rebound = await lstat(record.canonicalPath);
		if (rebound.isSymbolicLink()) throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
		const reboundPath = await stat(record.canonicalPath);
		if (!reboundPath.isFile() || reboundPath.dev !== opened.dev || reboundPath.ino !== opened.ino)
			throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
	} catch (error) {
		await handle?.close();
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			actions.settle(`watcher error: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
	const present = current !== null;
	let digest = "";
	try {
		digest = present && handle ? await digestFileHandle(handle) : "";
		if (present && handle) {
			const afterDigest = await stat(record.canonicalPath);
			const opened = await handle.stat();
			if (afterDigest.dev !== opened.dev || afterDigest.ino !== opened.ino)
				throw new Error(`Cannot watch file: target identity changed: ${record.path}`);
		}
	} finally {
		await handle?.close();
	}
	const changed =
		record.event === "create"
			? !record.present && present
			: record.present &&
				present &&
				(current!.mtimeMs !== record.mtimeMs || current!.size !== record.size || digest !== record.digest);
	record.pendingChange ||= changed;
	if (!record.present && current) {
		record.device = current.dev;
		record.inode = current.ino;
	}
	record.present = present;
	record.mtimeMs = current?.mtimeMs ?? 0;
	record.size = current?.size ?? 0;
	record.digest = digest;
	if (!record.pendingChange || record.paused || record.settled) return;
	record.pendingChange = false;
	if (record.settled) return;
	actions.fire(`${record.event} ${record.path}`);
}
