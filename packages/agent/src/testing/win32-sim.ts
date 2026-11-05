/**
 * Win32 simulation profile for code-level Windows tests on any host (test support only; no product code imports it).
 *
 * It simulates five Windows behaviors:
 * - `\` paths with a drive letter (`C:\dir\file`), mapped onto a backing POSIX directory;
 * - case-insensitive, case-preserving names;
 * - named-pipe endpoints (`\\.\pipe\<name>`), which are not filesystem paths;
 * - `EBUSY`/`EPERM` on rename or delete of a file that is open;
 * - signal-less process termination: a supported signal terminates at once and no handler runs.
 */
import type { ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

type Win32ErrorCode = "EBUSY" | "EPERM" | "ENOSYS";

export type Win32OpenFileErrorCode = "EBUSY" | "EPERM";

/** Node's Windows errno values (libuv `UV_E*` on win32). */
const WIN32_ERRNO: Record<Win32ErrorCode, number> = { EBUSY: -4082, EPERM: -4048, ENOSYS: -4054 };

const WIN32_ERROR_DESCRIPTION: Record<Win32ErrorCode, string> = {
	EBUSY: "resource busy or locked",
	EPERM: "operation not permitted",
	ENOSYS: "function not implemented",
};

/** The errno error shape Node throws on Windows, with `dest` for two-path calls such as rename. */
export interface Win32ErrnoException extends NodeJS.ErrnoException {
	dest?: string;
}

/** Builds the error Node throws on Windows for `code` from `syscall`. */
export function win32Error(
	code: Win32ErrorCode,
	syscall: string,
	filePath?: string,
	dest?: string,
): Win32ErrnoException {
	let target = "";
	if (filePath !== undefined) target = dest === undefined ? ` '${filePath}'` : ` '${filePath}' -> '${dest}'`;
	const error: Win32ErrnoException = new Error(`${code}: ${WIN32_ERROR_DESCRIPTION[code]}, ${syscall}${target}`);
	error.code = code;
	error.errno = WIN32_ERRNO[code];
	error.syscall = syscall;
	if (filePath !== undefined) error.path = filePath;
	if (dest !== undefined) error.dest = dest;
	return error;
}

/** Compares two Windows names (path segments, paths or pipe names) the way Windows does: case-insensitively. */
export function win32NamesEqual(left: string, right: string): boolean {
	return left.toUpperCase() === right.toUpperCase();
}

const DRIVE_LETTER = /^[A-Za-z]$/;
const DRIVE_PATH = /^([A-Za-z]):\\(.*)$/s;

/** Turns a relative POSIX-style path (`dir/file`) into a drive-letter Windows path (`C:\dir\file`). */
export function toWin32Path(relativePath: string, drive = "C"): string {
	if (!DRIVE_LETTER.test(drive))
		throw new RangeError(`win32 sim: drive must be one letter, got ${JSON.stringify(drive)}`);
	if (relativePath.startsWith("/")) {
		throw new RangeError(`win32 sim: expected a relative path, got ${JSON.stringify(relativePath)}`);
	}
	return path.win32.join(`${drive.toUpperCase()}:\\`, ...relativePath.split("/"));
}

/** True for an absolute drive-letter path such as `C:\dir` (forward slashes are accepted, as on Windows). */
export function isWin32DrivePath(candidate: string): boolean {
	return DRIVE_PATH.test(path.win32.normalize(candidate));
}

export const WIN32_PIPE_PREFIX = "\\\\.\\pipe\\";

/** Windows limits a full pipe name to 256 characters. */
const WIN32_PIPE_MAX_LENGTH = 256;

/** Builds the named-pipe endpoint (`\\.\pipe\<name>`) a Windows transport listens on instead of a socket file. */
export function win32PipeEndpoint(name: string): string {
	if (name.length === 0 || name.includes("\\")) {
		throw new RangeError(
			`win32 sim: a pipe name must be non-empty and contain no backslash, got ${JSON.stringify(name)}`,
		);
	}
	const endpoint = `${WIN32_PIPE_PREFIX}${name}`;
	if (endpoint.length > WIN32_PIPE_MAX_LENGTH) {
		throw new RangeError(`win32 sim: a pipe endpoint is at most ${WIN32_PIPE_MAX_LENGTH} characters`);
	}
	return endpoint;
}

/** True when `endpoint` is a local named-pipe endpoint; the prefix is matched case-insensitively, as on Windows. */
export function isWin32PipeEndpoint(endpoint: string): boolean {
	const name = endpoint.slice(WIN32_PIPE_PREFIX.length);
	return (
		win32NamesEqual(endpoint.slice(0, WIN32_PIPE_PREFIX.length), WIN32_PIPE_PREFIX) &&
		name.length > 0 &&
		!name.includes("\\")
	);
}

export interface Win32SimFsOptions {
	/** Backing POSIX directory; drive `C:` maps to `<root>/C`. */
	root: string;
	/** Error for a rename whose source or destination is open. Default `EPERM`. */
	renameOpenFileError?: Win32OpenFileErrorCode;
	/** Error for an unlink or rm that would remove an open file. Default `EBUSY`. */
	deleteOpenFileError?: Win32OpenFileErrorCode;
}

/** An open file in a {@link Win32SimFs}; the file counts as open until `close()`. */
export interface Win32SimFileHandle {
	readonly handle: fsp.FileHandle;
	close(): Promise<void>;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/**
 * A filesystem that behaves like Windows over a backing directory: it takes only drive-letter paths, resolves every
 * segment case-insensitively while keeping the case a name was created with, and refuses to rename or delete an open
 * file with Windows errors.
 */
export class Win32SimFs {
	readonly #root: string;
	readonly #renameOpenFileError: Win32OpenFileErrorCode;
	readonly #deleteOpenFileError: Win32OpenFileErrorCode;
	readonly #openCounts = new Map<string, number>();

	constructor(options: Win32SimFsOptions) {
		this.#root = options.root;
		this.#renameOpenFileError = options.renameOpenFileError ?? "EPERM";
		this.#deleteOpenFileError = options.deleteOpenFileError ?? "EBUSY";
	}

	/** Maps a drive-letter path to its backing path, matching existing names case-insensitively. */
	async resolve(win32Path: string): Promise<string> {
		const match = DRIVE_PATH.exec(path.win32.normalize(win32Path));
		if (match === null) {
			throw new TypeError(
				`win32 sim: expected a drive-letter path such as C:\\dir\\file, got ${JSON.stringify(win32Path)}`,
			);
		}
		const [, drive = "", rest = ""] = match;
		const segments = rest.split("\\").filter((segment) => segment.length > 0);
		let current = path.join(this.#root, drive.toUpperCase());
		for (const [index, segment] of segments.entries()) {
			let entries: string[];
			try {
				entries = await fsp.readdir(current);
			} catch (error) {
				if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
					return path.join(current, ...segments.slice(index));
				}
				throw error;
			}
			current = path.join(current, entries.find((entry) => win32NamesEqual(entry, segment)) ?? segment);
		}
		return current;
	}

	async mkdir(win32Path: string): Promise<void> {
		await fsp.mkdir(await this.resolve(win32Path), { recursive: true });
	}

	async writeFile(win32Path: string, data: string | Uint8Array): Promise<void> {
		await fsp.writeFile(await this.resolve(win32Path), data);
	}

	async readFile(win32Path: string): Promise<Buffer> {
		return fsp.readFile(await this.resolve(win32Path));
	}

	/** Names in a directory, in the case each was created with. */
	async readdir(win32Path: string): Promise<string[]> {
		return (await fsp.readdir(await this.resolve(win32Path))).sort();
	}

	async exists(win32Path: string): Promise<boolean> {
		try {
			await fsp.stat(await this.resolve(win32Path));
			return true;
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return false;
			throw error;
		}
	}

	/** Opens a file; until `close()` it cannot be renamed or deleted. */
	async open(win32Path: string, flags = "r"): Promise<Win32SimFileHandle> {
		const backing = await this.resolve(win32Path);
		const handle = await fsp.open(backing, flags);
		this.#openCounts.set(backing, (this.#openCounts.get(backing) ?? 0) + 1);
		let closed = false;
		return {
			handle,
			close: async () => {
				if (closed) return;
				closed = true;
				const remaining = (this.#openCounts.get(backing) ?? 1) - 1;
				if (remaining === 0) this.#openCounts.delete(backing);
				else this.#openCounts.set(backing, remaining);
				await handle.close();
			},
		};
	}

	/** Renames or replaces a file; a rename that only changes a name's case keeps one entry with the new case. */
	async rename(from: string, to: string): Promise<void> {
		const source = await this.resolve(from);
		let target = await this.resolve(to);
		if (this.#isOpen(source) || this.#isOpen(target)) throw win32Error(this.#renameOpenFileError, "rename", from, to);
		if (target === source) target = path.join(path.dirname(source), path.win32.basename(path.win32.normalize(to)));
		await fsp.rename(source, target);
	}

	async unlink(win32Path: string): Promise<void> {
		const backing = await this.resolve(win32Path);
		if (this.#isOpen(backing)) throw win32Error(this.#deleteOpenFileError, "unlink", win32Path);
		await fsp.unlink(backing);
	}

	/** Like `fs.rm` with `recursive`; fails with the delete error while any file at or under the path is open. */
	async rm(win32Path: string): Promise<void> {
		const backing = await this.resolve(win32Path);
		const inside = `${backing}${path.sep}`;
		for (const open of this.#openCounts.keys()) {
			if (open === backing || open.startsWith(inside)) throw win32Error(this.#deleteOpenFileError, "rm", win32Path);
		}
		await fsp.rm(backing, { recursive: true });
	}

	#isOpen(backing: string): boolean {
		return this.#openCounts.has(backing);
	}
}

/** The signals Node accepts on Windows; every one of them terminates the process outright. */
const WIN32_KILL_SIGNALS = new Set<NodeJS.Signals>(["SIGKILL", "SIGTERM", "SIGINT", "SIGQUIT"]);

/**
 * Sends `signal` with Windows semantics. Signal `0` only probes liveness. A supported signal terminates the process
 * immediately, so no signal handler runs (the POSIX child is sent `SIGKILL` and reports it). Any other signal throws
 * `ENOSYS` and leaves the process running.
 */
export function win32Kill(target: ChildProcess | number, signal: NodeJS.Signals | 0 = "SIGTERM"): boolean {
	if (signal !== 0 && !WIN32_KILL_SIGNALS.has(signal)) throw win32Error("ENOSYS", "kill");
	const posixSignal = signal === 0 ? 0 : "SIGKILL";
	if (typeof target === "number") return process.kill(target, posixSignal);
	return target.kill(posixSignal);
}
