import { constants, cpSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import chalk from "chalk";

const REGENERABLE_ENTRIES: ReadonlySet<string> = new Set(["cache", "logs", "tmp", "migrations-state.json"]);

export function isRegenerableEntry(entry: string): boolean {
	return REGENERABLE_ENTRIES.has(entry) || entry.endsWith(".log");
}

export function pathsPointToSameLocation(leftPath: string, rightPath: string): boolean {
	try {
		return realpathSync(leftPath) === realpathSync(rightPath);
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

/** Resolves symlinks in the longest existing prefix, so `/tmp/x` and `/private/tmp/x` compare equal. */
function canonicalPath(path: string): string {
	const absolute = resolve(path);
	if (existsSync(absolute)) return realpathSync(absolute);
	const parent = dirname(absolute);
	return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
}

export function isWithinOrSamePath(childPath: string, parentPath: string): boolean {
	const relativePath = relative(canonicalPath(parentPath), canonicalPath(childPath));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Copies the top-level entries of `source` that `target` lacks. Never overwrites and only reads
 * `source`; clones copy-on-write where supported so large session trees cost no extra space.
 */
export function copyMissingEntries(
	source: string,
	target: string,
	include: (entry: string) => boolean,
): readonly string[] {
	let entries: string[];
	try {
		entries = readdirSync(source);
	} catch (error) {
		if (isMissingPathError(error)) return [];
		throw error;
	}

	const copied: string[] = [];
	for (const entry of entries) {
		if (!include(entry) || existsSync(join(target, entry))) continue;
		try {
			mkdirSync(target, { recursive: true });
			cpSync(join(source, entry), join(target, entry), {
				recursive: true,
				force: false,
				errorOnExist: false,
				preserveTimestamps: true,
				mode: constants.COPYFILE_FICLONE,
			});
			copied.push(entry);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.warn(chalk.yellow(`Could not copy ${join(source, entry)} → ${join(target, entry)}: ${reason}`));
		}
	}
	return copied;
}
