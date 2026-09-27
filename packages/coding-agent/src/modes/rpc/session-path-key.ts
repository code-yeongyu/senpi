import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The key a session file is reserved under: one key for every spelling of one file (macOS
 * `/tmp` vs `/private/tmp`, a symlinked workspace root). A path whose directory is gone keeps
 * its missing tail verbatim under the deepest ancestor that still exists, so another session's
 * deleted directory can never fail a listing or an open (senpi#2206).
 */
export function canonicalSessionPath(path: string): string {
	const absolutePath = resolve(path);
	const missing: string[] = [];
	let existing = absolutePath;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return absolutePath;
		missing.unshift(basename(existing));
		existing = parent;
	}
	try {
		return join(realpathSync(existing), ...missing);
	} catch {
		// A delete racing the existence check leaves the given spelling as the only one; a key
		// that misses an alias still beats a listing that throws.
		return absolutePath;
	}
}

/** The directory a session writes its transcript into is gone: it can never persist again. */
export function sessionDirectoryRemoved(sessionFile: string): boolean {
	return !existsSync(dirname(sessionFile));
}
