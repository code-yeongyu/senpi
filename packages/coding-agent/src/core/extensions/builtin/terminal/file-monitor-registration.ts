/**
 * What a file watch proves about its target before it exists: the parent directory is reachable and is
 * the one the permission check approved, and the target (when present) is a regular file, not a
 * symlink, whose identity holds across the checks. A missing target is allowed (a create watch).
 * Identity is derived without open(2) on the parent, so neither side can block on a wedged mount.
 */
import type { Stats } from "node:fs";
import { access, type FileHandle, lstat, open, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import type { PendingFileRegistration, RegistrationGuard } from "./file-monitor-guard.ts";
import type { RegisterFileMonitorOptions } from "./file-monitor-record.ts";

export interface WatchTarget {
	readonly path: string;
	readonly parent: string;
	readonly approvedParent: string;
	readonly initial: Stats | null;
	readonly initialHandle: FileHandle | undefined;
}

/** Throws the registration's error; the caller ends the pending registration. */
export async function proveWatchTarget(
	guard: RegistrationGuard,
	pending: PendingFileRegistration,
	options: RegisterFileMonitorOptions,
	isDisposed: () => boolean,
): Promise<WatchTarget> {
	const path = resolve(options.cwd, options.path);
	const parent = dirname(path);
	let approvedParent: string;
	try {
		await guard.await(pending, access(parent));
		// Identity is derived without open(2), with the same walker the permission parser used, so the
		// two sides agree byte-for-byte and neither can block on a wedged mount.
		approvedParent = realpathWithoutOpen(parent);
		const approvedParentAtPermission = options.approvedParent;
		if (approvedParentAtPermission !== undefined && approvedParent !== approvedParentAtPermission) {
			throw new Error(`Cannot watch file: parent directory changed during permission approval: ${parent}`);
		}
		if (isDisposed()) throw new Error("Cannot create file monitor: monitor registry is disposed.");
	} catch (error) {
		if (error instanceof Error && error.message.includes("disposed")) throw error;
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw new Error(
				`Cannot access parent directory ${parent}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		throw new Error(`Cannot watch file: parent directory does not exist: ${parent}`);
	}
	let initial: Stats | null = null;
	let initialHandle: FileHandle | undefined;
	try {
		const target = await guard.await(pending, lstat(path));
		if (target.isSymbolicLink()) throw new Error(`Cannot watch file: target is a symbolic link: ${path}`);
		initialHandle = await guard.await(pending, open(path, "r"), async (handle) => {
			await handle.close();
		});
		initial = await guard.await(pending, initialHandle.stat());
		if (!initial.isFile()) throw new Error(`Cannot watch file: target is not a regular file: ${path}`);
		const resolvedTarget = realpathWithoutOpen(path);
		if (resolvedTarget !== join(approvedParent, basename(path)))
			throw new Error(`Cannot watch file: target identity changed: ${path}`);
		const rebound = await guard.await(pending, lstat(path));
		if (rebound.isSymbolicLink()) throw new Error(`Cannot watch file: target identity changed: ${path}`);
		const reboundStat = await guard.await(pending, stat(path));
		if (!reboundStat.isFile() || reboundStat.dev !== initial.dev || reboundStat.ino !== initial.ino)
			throw new Error(`Cannot watch file: target identity changed: ${path}`);
	} catch (error) {
		await initialHandle?.close();
		initialHandle = undefined;
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
	return { path, parent, approvedParent, initial, initialHandle };
}
