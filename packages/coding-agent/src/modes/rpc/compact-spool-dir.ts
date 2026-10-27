import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeCause } from "./compact-storage-io.ts";

/**
 * Ownership of the compact spool's epoch directory (senpi#4272). The store creates the directory
 * itself (0700, never adopting an existing one) and writes a private marker into it; removal
 * re-checks the directory and that marker without following symlinks, so retirement never deletes
 * a directory this store did not create and still own.
 */

const MARKER = ".compact-spool-owner";

type CompactSpoolRefusal =
	| "pre_existing"
	| "marker_write_failed"
	| "symlink"
	| "not_directory"
	| "marker_missing"
	| "foreign_owner"
	| "wide_mode";

class CompactSpoolRefusedError extends Error {
	readonly reason: CompactSpoolRefusal;
	readonly path: string;

	constructor(reason: CompactSpoolRefusal, path: string, cause?: unknown, cleanupFailure?: unknown) {
		const detail = cause === undefined ? "" : `: ${describeCause(cause)}`;
		const kept =
			cleanupFailure === undefined ? "" : `; removing the directory failed: ${describeCause(cleanupFailure)}`;
		super(`compact spool directory refused (${reason}): ${path}${detail}${kept}`, { cause });
		this.name = "CompactSpoolRefusedError";
		this.reason = reason;
		this.path = path;
	}
}

/** Creates a fresh private epoch directory and returns the token its ownership marker holds. */
export async function createSpoolDir(dir: string): Promise<string> {
	await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
	try {
		await mkdir(dir, { mode: 0o700 });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new CompactSpoolRefusedError("pre_existing", dir);
		throw cause;
	}
	const token = randomUUID();
	try {
		await writeFile(join(dir, MARKER), token, { flag: "wx", mode: 0o600 });
	} catch (cause) {
		throw await abandonSpoolDir(dir, cause);
	}
	return token;
}

/**
 * Removes a directory `createSpoolDir` just made but could not mark, so a later store creates it
 * fresh instead of refusing it as pre-existing. Only a marker this call's exclusive create made (any
 * failure but EEXIST) is unlinked, then the directory itself, which `rmdir` removes only while empty.
 */
async function abandonSpoolDir(dir: string, cause: unknown): Promise<CompactSpoolRefusedError> {
	try {
		if ((cause as NodeJS.ErrnoException).code !== "EEXIST") await rm(join(dir, MARKER), { force: true });
		await rmdir(dir);
		return new CompactSpoolRefusedError("marker_write_failed", dir, cause);
	} catch (cleanupFailure) {
		return new CompactSpoolRefusedError("marker_write_failed", dir, cause, cleanupFailure);
	}
}

/**
 * Removes `dir` only while it is still the private, marked directory `createSpoolDir` made. A
 * directory that is already gone leaves nothing to remove, so retirement settles as a no-op.
 */
export async function removeSpoolDir(dir: string, token: string): Promise<void> {
	const owned = await lstat(dir).catch((cause: unknown) => {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw cause;
	});
	if (owned === undefined) return;
	const refusal = await refusalFor(dir, owned, token);
	if (refusal) throw new CompactSpoolRefusedError(refusal, dir);
	await rm(dir, { recursive: true, force: true });
}

async function refusalFor(dir: string, owned: Stats, token: string): Promise<CompactSpoolRefusal | undefined> {
	if (owned.isSymbolicLink()) return "symlink";
	if (!owned.isDirectory()) return "not_directory";
	const markerPath = join(dir, MARKER);
	const marker = await lstat(markerPath).catch(() => undefined);
	if (!marker?.isFile() || (await readFile(markerPath, "utf8")) !== token) return "marker_missing";
	// Windows has no POSIX owner or mode bits; the marker token and the no-follow checks still apply.
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	if (owned.uid !== uid || marker.uid !== uid) return "foreign_owner";
	if (((owned.mode | marker.mode) & 0o077) !== 0) return "wide_mode";
	return undefined;
}
