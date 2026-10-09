import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Directory fsync is not a supported operation here; the rename itself already happened. */
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);

/** The temp file cannot be created because the directory refuses new entries. */
const DIRECTORY_NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);

type ReplaceTarget = {
	readonly path: string;
	readonly mode: number | undefined;
};

function errnoCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** A symlinked session file keeps its link: the replacement lands on the file it points at. */
function resolveTarget(filePath: string): ReplaceTarget {
	try {
		const path = realpathSync(filePath);
		return { path, mode: statSync(path).mode & 0o7777 };
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return { path: filePath, mode: undefined };
		throw error;
	}
}

function openTemp(tempPath: string): number | undefined {
	try {
		return openSync(tempPath, "wx");
	} catch (error) {
		const code = errnoCode(error);
		if (code !== undefined && DIRECTORY_NOT_WRITABLE.has(code)) return undefined;
		throw error;
	}
}

/** The pre-atomic rewrite, kept for a writable file in a directory that takes no new entries. */
function rewriteInPlace(path: string, chunks: Iterable<string>): void {
	const fd = openSync(path, "w");
	try {
		for (const chunk of chunks) {
			writeFileSync(fd, chunk);
		}
	} finally {
		closeSync(fd);
	}
}

function writeDurably(fd: number, chunks: Iterable<string>, mode: number | undefined): void {
	try {
		if (mode !== undefined) fchmodSync(fd, mode);
		for (const chunk of chunks) {
			writeFileSync(fd, chunk);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function syncDirectory(directory: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(directory, "r");
	try {
		fsyncSync(fd);
	} catch (error) {
		const code = errnoCode(error);
		if (code === undefined || !UNSUPPORTED_DIRECTORY_SYNC.has(code)) throw error;
	} finally {
		closeSync(fd);
	}
}

/**
 * Replaces `filePath` with the concatenated `chunks` so that no failure can leave a
 * partial file behind: the content goes to a temp file in the same directory, is
 * fsynced, and is renamed over the target (on Windows libuv renames with
 * MOVEFILE_REPLACE_EXISTING), then the directory entry is fsynced where supported.
 * A failure before the rename leaves the original byte-identical, removes the temp
 * file, and rethrows; if the temp file cannot be removed either, both errors surface.
 * When the directory refuses the temp file (EACCES/EPERM/EROFS) the file is rewritten
 * in place as before, so a writable file in a read-only directory still migrates.
 */
export function replaceFileAtomically(filePath: string, chunks: Iterable<string>): void {
	const target = resolveTarget(filePath);
	const tempPath = join(dirname(target.path), `.${basename(target.path)}.${randomUUID()}.tmp`);
	const tempFd = openTemp(tempPath);
	if (tempFd === undefined) {
		rewriteInPlace(target.path, chunks);
		return;
	}
	try {
		writeDurably(tempFd, chunks, target.mode);
		renameSync(tempPath, target.path);
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"session file rewrite failed and its temporary file could not be removed",
			);
		}
		throw error;
	}
	syncDirectory(dirname(target.path));
}
