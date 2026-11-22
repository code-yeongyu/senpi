import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FileSignature, FsAccess } from "./scan-boundaries.ts";
import { excludedDirectories, isSourcePath } from "./source-file.ts";

/** The workspace's source-file locations: a path whose real location is not one does not exist here. */
export interface ScanFs {
	/** The signature of a regular file; undefined for anything else, a symlink and a missing path included. */
	stat(path: string): Promise<FileSignature | undefined>;
	/** At most `limit` leading bytes of a file; undefined when it cannot be read. */
	read(path: string, limit: number): Promise<Uint8Array | undefined>;
}

export interface WorkspaceRoots {
	readonly cwd: string;
	/** The session's artifacts directory, wherever it lies. */
	readonly artifactsDir: string;
}

/**
 * The one place that decides whether a path the scan was given may be stat'd and read: git names paths lexically, and
 * a directory in one can be a symlink to anywhere. A path qualifies when its real location, directories resolved, lies
 * inside the real workspace, outside every excluded directory and the session's artifacts, and the stat and the read
 * reach that location without following its last entry.
 *
 * An excluded directory is found by what it is, not only by how it is spelled: a segment that differs from an
 * excluded name only in case is excluded when the filesystem resolves both spellings to the same directory, which a
 * case-insensitive one does and a case-sensitive one does not. Only confirmed absence of either spelling shows the
 * two apart; a lookup that could not tell (permission, I/O, a link loop) excludes the segment.
 *
 * A read takes bytes only from the regular file the stat just saw (same device and inode), and only after the open
 * shows the path still names that file at the same real location, its last entry not a link: a platform that cannot
 * refuse to follow a last entry may have opened a link to the checked file moved out of the workspace. What remains:
 * the checks bracket the open, not the read, so a file moved out after them is read through the descriptor opened
 * while it was inside; and a directory swapped away and back between two checks is not seen.
 */
export function workspaceFs(roots: WorkspaceRoots, access: FsAccess): ScanFs {
	/** False only when the two spellings are shown to be distinct directories. */
	const maybeSameDirectory = async (spelled: string, named: string): Promise<boolean> => {
		const [left, right] = await Promise.all([access.identity(spelled), access.identity(named)]);
		if (left.kind === "unknown" || right.kind === "unknown") return true;
		if (left.kind === "absent" || right.kind === "absent") return false;
		// Without an inode two existing directories cannot be told apart, so the spelled one counts as excluded.
		return left.ino === 0 || right.ino === 0 || (left.dev === right.dev && left.ino === right.ino);
	};
	const excludedAlias = async (root: string, segments: readonly string[]): Promise<boolean> => {
		const checks = segments.flatMap((segment, index) =>
			excludedDirectories()
				.filter((name) => segment !== name && segment.toUpperCase() === name.toUpperCase())
				.map((name) => {
					const parent = join(root, ...segments.slice(0, index));
					return maybeSameDirectory(join(parent, segment), join(parent, name));
				}),
		);
		return (await Promise.all(checks)).includes(true);
	};
	const locate = async (path: string): Promise<string | undefined> => {
		const [root, artifacts, directory] = await Promise.all([
			access.realpath(roots.cwd),
			access.realpath(roots.artifactsDir),
			access.realpath(dirname(path)),
		]);
		if (root === undefined || directory === undefined) return undefined;
		const located = join(directory, basename(path));
		const inside = relative(root, located);
		const segments = inside.split(sep);
		if (escapesWorkspace(inside) || !isSourcePath(segments.join("/")) || (await excludedAlias(root, segments)))
			return undefined;
		return artifacts === undefined || escapesWorkspace(relative(artifacts, located)) ? located : undefined;
	};
	return {
		stat: async (path) => {
			const located = await locate(path);
			return located === undefined ? undefined : await access.lstat(located);
		},
		read: async (path, limit) => {
			const located = await locate(path);
			if (located === undefined) return undefined;
			const checked = await access.lstat(located);
			// Without an inode the opened file cannot be shown to be the checked one.
			if (checked === undefined || checked.ino === 0) return undefined;
			return await access.read(located, limit, async (opened) => {
				if (!sameFile(opened, checked)) return false;
				const [again, real, entry] = await Promise.all([
					locate(path),
					access.realpath(located),
					access.lstat(located),
				]);
				return again === located && real === located && entry !== undefined && sameFile(entry, checked);
			});
		},
	};
}

function sameFile(left: FileSignature, right: FileSignature): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Whether a path relative to a directory leaves it: the parent segment, a path below it, or another root. A name that
 * only begins with two dots (`..draft.ts`) stays inside.
 */
export function escapesWorkspace(inside: string): boolean {
	return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}
