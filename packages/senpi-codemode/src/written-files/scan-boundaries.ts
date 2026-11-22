import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** What a scan compares between two moments; a rewrite changes at least one of these. */
export interface FileSignature {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	/** Differs after a rename-over write even where timestamps are too coarse to. */
	readonly ino: number;
}

/** The filesystem as the operating system resolves it: symlinks in a path's directories are followed. */
export interface FsAccess {
	/** The path with every symlink in it resolved; undefined when it does not resolve. */
	realpath(path: string): Promise<string | undefined>;
	/** The signature of a regular file, its last entry not followed; undefined for a symlink, anything else and a missing path. */
	lstat(path: string): Promise<FileSignature | undefined>;
	/** At most `limit` leading bytes of a file, its last entry not followed; undefined when it cannot be read. */
	read(path: string, limit: number): Promise<Uint8Array | undefined>;
}

/** The workspace's files: a path whose real location, its directories resolved, lies outside the workspace is not one. */
export interface ScanFs {
	/** The signature of a regular file; undefined for anything else, a symlink and a missing path included. */
	stat(path: string): Promise<FileSignature | undefined>;
	/** At most `limit` leading bytes of a file; undefined when it cannot be read. */
	read(path: string, limit: number): Promise<Uint8Array | undefined>;
}

export type GitOutcome =
	| { readonly kind: "ok"; readonly stdout: string }
	| { readonly kind: "exit"; readonly code: number }
	/** Killed at the deadline, or its output outgrew the cap. */
	| { readonly kind: "over_budget" }
	| { readonly kind: "unavailable" };

export type RunGit = (
	args: readonly string[],
	options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<GitOutcome>;

const GIT_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Confines every stat and read to the real workspace: git names paths lexically, and a directory in one can be a
 * symlink to anywhere. Each call resolves the path's directories and stats or reads that resolved path, and a read
 * whose directories resolve elsewhere once it is done returns nothing, so a link swapped in meanwhile leaks no bytes.
 */
export function workspaceFs(root: string, access: FsAccess): ScanFs {
	const locate = async (path: string): Promise<string | undefined> => {
		const [realRoot, realDirectory] = await Promise.all([access.realpath(root), access.realpath(dirname(path))]);
		if (realRoot === undefined || realDirectory === undefined) return undefined;
		const inside = relative(realRoot, realDirectory);
		if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
		return join(realDirectory, basename(path));
	};
	return {
		stat: async (path) => {
			const located = await locate(path);
			return located === undefined ? undefined : await access.lstat(located);
		},
		read: async (path, limit) => {
			const located = await locate(path);
			if (located === undefined) return undefined;
			const bytes = await access.read(located, limit);
			return bytes !== undefined && (await locate(path)) === located ? bytes : undefined;
		},
	};
}

export function createNodeFsAccess(): FsAccess {
	return { realpath: realLocation, lstat: statRegularFile, read: readLeadingBytes };
}

async function realLocation(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function statRegularFile(path: string): Promise<FileSignature | undefined> {
	try {
		const stats = await lstat(path);
		if (!stats.isFile()) return undefined;
		return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino };
	} catch {
		return undefined;
	}
}

async function readLeadingBytes(path: string, limit: number): Promise<Uint8Array | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		// Refuses a symlink as the last entry; Windows has no such flag.
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const buffer = new Uint8Array(Math.min(limit, (await handle.stat()).size));
		let filled = 0;
		while (filled < buffer.length) {
			const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		return buffer.subarray(0, filled);
	} catch {
		return undefined;
	} finally {
		await handle?.close();
	}
}

/** Runs git without taking its optional locks, so a scan never rewrites the index of a repository in use. */
export function createGitRunner(inheritedEnv: () => Readonly<Record<string, string | undefined>>): RunGit {
	return (args, options) =>
		new Promise((resolve) => {
			// A caller's repository selection must not redirect the scan to another repository or index.
			const {
				GIT_DIR: _gitDir,
				GIT_WORK_TREE: _workTree,
				GIT_INDEX_FILE: _indexFile,
				GIT_PREFIX: _prefix,
				...inherited
			} = inheritedEnv();
			execFile(
				"git",
				[...args],
				{
					cwd: options.cwd,
					timeout: options.timeoutMs,
					maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
					encoding: "utf8",
					windowsHide: true,
					env: { ...inherited, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
				},
				(error, stdout) => {
					if (error === null) resolve({ kind: "ok", stdout });
					else if (error.code === "ENOENT") resolve({ kind: "unavailable" });
					else if (typeof error.code === "number") resolve({ kind: "exit", code: error.code });
					else if (error.killed === true || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
						resolve({ kind: "over_budget" });
					else resolve({ kind: "exit", code: -1 });
				},
			);
		});
}
