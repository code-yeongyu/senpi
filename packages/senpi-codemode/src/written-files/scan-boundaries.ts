import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";

/** What a scan compares between two moments; a rewrite changes at least one of these. */
export interface FileSignature {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	/** With `ino`, which file this is: differs after a rename-over write even where timestamps are too coarse to. */
	readonly ino: number;
	readonly dev: number;
}

/**
 * What a path names, every symlink followed. `absent` is confirmed absence (nothing there, or a parent is not a
 * directory); `unknown` is any lookup that could not tell, a permission error or a link loop among them.
 */
export type PathIdentity =
	| { readonly kind: "found"; readonly dev: number; readonly ino: number }
	| { readonly kind: "absent" }
	| { readonly kind: "unknown" };

/** The filesystem as the operating system resolves it: symlinks in a path's directories are followed. */
export interface FsAccess {
	/** The path with every symlink in it resolved; undefined when it does not resolve. */
	realpath(path: string): Promise<string | undefined>;
	/** The signature of a regular file, its last entry not followed; undefined for a symlink, anything else and a missing path. */
	lstat(path: string): Promise<FileSignature | undefined>;
	/** The device and inode of whatever the path names, every symlink followed. */
	identity(path: string): Promise<PathIdentity>;
	/**
	 * Opens the path, refusing a symlink as its last entry where the platform can, and reads at most `limit` leading
	 * bytes only when the file it opened is a regular file `accept` takes, asked after the open and before any read;
	 * undefined otherwise.
	 */
	read(
		path: string,
		limit: number,
		accept: (opened: FileSignature) => Promise<boolean>,
	): Promise<Uint8Array | undefined>;
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

export function createNodeFsAccess(): FsAccess {
	return { realpath: realLocation, lstat: statRegularFile, identity: identityOf, read: readLeadingBytes };
}

async function identityOf(path: string): Promise<PathIdentity> {
	try {
		const stats = await stat(path);
		return { kind: "found", dev: stats.dev, ino: stats.ino };
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unknown" };
	}
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
		return signatureOf(stats);
	} catch {
		return undefined;
	}
}

function signatureOf(stats: Stats): FileSignature {
	return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, dev: stats.dev };
}

async function readLeadingBytes(
	path: string,
	limit: number,
	accept: (opened: FileSignature) => Promise<boolean>,
): Promise<Uint8Array | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		// No-follow refuses a symlink as the last entry (Windows has no such flag, `accept` decides there); non-blocking
		// keeps a FIFO swapped in from holding the open, and the file type is checked before a byte is read.
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const opened = await handle.stat();
		if (!opened.isFile() || !(await accept(signatureOf(opened)))) return undefined;
		const buffer = new Uint8Array(Math.min(limit, opened.size));
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
