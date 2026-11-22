import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FileSignature, FsAccess } from "./scan-boundaries.ts";
import { isSourcePath } from "./source-file.ts";

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
 * reach that location without following its last entry. A read returns bytes only from the regular file the stat just
 * saw (same device and inode), so a last entry swapped for a link, on a platform that cannot refuse to follow one, is
 * not read; and only while the directories still resolve to the same place once it is done.
 */
export function workspaceFs(roots: WorkspaceRoots, access: FsAccess): ScanFs {
	const locate = async (path: string): Promise<string | undefined> => {
		const [root, artifacts, directory] = await Promise.all([
			access.realpath(roots.cwd),
			access.realpath(roots.artifactsDir),
			access.realpath(dirname(path)),
		]);
		if (root === undefined || directory === undefined) return undefined;
		const located = join(directory, basename(path));
		const inside = relative(root, located);
		if (escapes(inside) || !isSourcePath(inside.split(sep).join("/"))) return undefined;
		return artifacts === undefined || escapes(relative(artifacts, located)) ? located : undefined;
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
			const bytes = await access.read(
				located,
				limit,
				(opened) => opened.dev === checked.dev && opened.ino === checked.ino,
			);
			return bytes !== undefined && (await locate(path)) === located ? bytes : undefined;
		},
	};
}

function escapes(inside: string): boolean {
	return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}
