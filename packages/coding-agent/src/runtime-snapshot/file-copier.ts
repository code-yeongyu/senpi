import { constants } from "node:fs";
import { copyFile, link } from "node:fs/promises";

function errorCode(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * How a file gets into a snapshot. A clone (APFS, btrfs, XFS, ReFS) is copy-on-write: free, and
 * independent of the install even if something rewrites the install's file in place. A hardlink
 * is just as free but shares the file itself, so it is only taken where the filesystem cannot
 * clone (ext4, NTFS); package managers replace files rather than rewriting them, which keeps a
 * linked snapshot on the build it was taken from. A plain copy is the last resort (another
 * volume, a filesystem that refuses links).
 */
export type SnapshotCopyMode = "clone" | "clone-or-copy" | "link" | "copy";

export interface SnapshotFileOperations {
	copyFile(source: string, target: string, mode: number): Promise<void>;
	link(source: string, target: string): Promise<void>;
}

const FILE_OPERATIONS: SnapshotFileOperations = { copyFile, link };

/** Clones go through the filesystem's metadata path, which stops scaling past a few in flight. */
const COPY_CONCURRENCY = 8;

function nextCopyMode(mode: SnapshotCopyMode, error: unknown, platform: NodeJS.Platform): SnapshotCopyMode | undefined {
	const code = errorCode(error);
	// A missing source or an occupied target is about this file, not about what the filesystem can do.
	if (code === "ENOENT" || code === "ENOTDIR" || code === "EEXIST") return undefined;
	switch (mode) {
		case "clone":
			// Node on macOS cannot force a clone (ENOSYS), but its plain clone request clones on APFS
			// and copies elsewhere, which is exactly the order wanted without ever sharing an inode.
			return platform === "darwin" && code === "ENOSYS" ? "clone-or-copy" : "link";
		case "link":
			return "copy";
		case "clone-or-copy":
		case "copy":
			return undefined;
	}
}

export interface SnapshotFileCopier {
	copy(source: string, target: string): Promise<void>;
	readonly mode: SnapshotCopyMode;
}

/**
 * A file copier that starts with the cheapest independent copy and settles on the first mode the
 * filesystem accepts, so a snapshot of thousands of files pays for a refused mode once.
 */
export function createSnapshotFileCopier(
	platform: NodeJS.Platform = process.platform,
	operations: SnapshotFileOperations = FILE_OPERATIONS,
): SnapshotFileCopier {
	let mode: SnapshotCopyMode = "clone";
	const attempt = (current: SnapshotCopyMode, source: string, target: string): Promise<void> => {
		switch (current) {
			case "clone":
				return operations.copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
			case "clone-or-copy":
				return operations.copyFile(source, target, constants.COPYFILE_FICLONE);
			case "link":
				return operations.link(source, target);
			case "copy":
				return operations.copyFile(source, target, 0);
		}
	};
	return {
		get mode() {
			return mode;
		},
		async copy(source, target) {
			for (let current = mode; ; ) {
				try {
					await attempt(current, source, target);
					return;
				} catch (error) {
					const next = nextCopyMode(current, error, platform);
					if (next === undefined) throw error;
					current = next;
					mode = next;
				}
			}
		},
	};
}

export async function copyFiles(
	pairs: readonly (readonly [string, string])[],
	copier: SnapshotFileCopier,
): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < pairs.length; index = next++) {
			const [source, target] = pairs[index] ?? [];
			if (source !== undefined && target !== undefined) await copier.copy(source, target);
		}
	};
	await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, pairs.length) }, worker));
}
