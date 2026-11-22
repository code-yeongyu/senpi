import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";

/** What a scan compares between two moments; a rewrite changes at least one of these. */
export interface FileSignature {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	/** Differs after a rename-over write even where timestamps are too coarse to. */
	readonly ino: number;
}

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

export function createNodeScanFs(): ScanFs {
	return { stat: statRegularFile, read: readLeadingBytes };
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
		handle = await open(path, "r");
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
