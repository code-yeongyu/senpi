import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DeviceFileError,
	type DeviceFiles,
	type DeviceFileStat,
	type DeviceRunRequest,
	type DeviceRunResult,
	FILE_CHANNEL_MAX_BYTES,
} from "./device-files.ts";

function deviceError(error: unknown, path: string): DeviceFileError {
	if (error instanceof DeviceFileError) return error;
	const code = (error as { code?: unknown }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOENT") return new DeviceFileError("not_found", path);
	if (code === "EEXIST") return new DeviceFileError("exists", path);
	if (code === "EISDIR" || code === "ENOTDIR" || code === "ENXIO") return new DeviceFileError("not_a_file", path);
	if (code === "ABORT_ERR") return new DeviceFileError("aborted", path);
	return new DeviceFileError("io", message);
}

async function guarded<T>(path: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	if (signal?.aborted) throw new DeviceFileError("aborted", path);
	try {
		return await run();
	} catch (error) {
		throw deviceError(error, path);
	}
}

/**
 * Opens a regular file only. The open never blocks (a named pipe with no peer would hold it, and a worker thread,
 * forever), and the type is checked on the opened descriptor, so nothing can swap the path in between.
 */
async function openRegular(path: string, flags: number): Promise<FileHandle> {
	const handle = await open(path, flags | constants.O_NONBLOCK, 0o666);
	try {
		if (!(await handle.stat()).isFile()) throw new DeviceFileError("not_a_file", path);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/** Reads at most the channel limit: a file that grows past it while being read is refused, never shipped in full. */
async function readBounded(path: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
	const handle = await openRegular(path, constants.O_RDONLY);
	try {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			if (signal?.aborted) throw new DeviceFileError("aborted", path);
			const chunk = new Uint8Array(64 * 1024);
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > FILE_CHANNEL_MAX_BYTES) throw new DeviceFileError("too_large", path);
			chunks.push(chunk.subarray(0, bytesRead));
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

/** A fused session's `run`: a direct spawn in `cwd`, no shell, no allowlist and no hop, as the caller spawns today. */
function runDirect(request: DeviceRunRequest, signal: AbortSignal | undefined): Promise<DeviceRunResult> {
	return new Promise((done, fail) => {
		const child = spawn(request.exe, [...request.argv], {
			cwd: request.cwd,
			env: request.env === undefined ? process.env : { ...process.env, ...request.env },
			shell: false,
			windowsHide: true,
			...(signal === undefined ? {} : { signal }),
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		let killTimer: NodeJS.Timeout | undefined;
		const timer =
			request.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						child.kill("SIGTERM");
						killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
					}, request.timeoutMs);
		child.on("error", (error) => fail(new DeviceFileError(signal?.aborted ? "aborted" : "io", error.message)));
		child.on("close", (code, exitSignal) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			done({
				code,
				signal: exitSignal,
				stdout: new Uint8Array(Buffer.concat(out)),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(request.stdin === undefined ? undefined : Buffer.from(request.stdin));
	});
}

function statOf(entry: Stats): DeviceFileStat {
	const kind = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
	return { kind, size: entry.size, mtimeMs: entry.mtimeMs };
}

/**
 * The local filesystem as {@link DeviceFiles}: what a fused session's extension code uses, called directly, and what a
 * hand runs a channel operation on once its grant, handlers and policy have allowed it. Reads and writes are bounded
 * by {@link FILE_CHANNEL_MAX_BYTES} before any data is in memory, so both sides of a split session agree on the limit.
 */
export function localDeviceFiles(): DeviceFiles {
	return {
		read: (path, options) => guarded(path, options?.signal, () => readBounded(path, options?.signal)),
		write: (path, data, options) =>
			guarded(path, options?.signal, async () => {
				if (data.byteLength > FILE_CHANNEL_MAX_BYTES) throw new DeviceFileError("too_large", path);
				await mkdir(dirname(path), { recursive: true });
				const handle = await openRegular(
					path,
					constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (options?.exclusive ? constants.O_EXCL : 0),
				);
				try {
					await handle.writeFile(data);
				} finally {
					await handle.close();
				}
			}),
		list: (path, options) => guarded(path, options?.signal, () => readdir(path)),
		stat: (path, options) => guarded(path, options?.signal, async () => statOf(await lstat(path))),
		rename: (from, to, options) => guarded(from, options?.signal, () => rename(from, to)),
		remove: (path, options) =>
			guarded(path, options?.signal, async () => {
				await lstat(path);
				await rm(path, { recursive: true });
			}),
		mkdir: (path, options) =>
			guarded(path, options?.signal, async () => {
				await mkdir(path, { recursive: true });
			}),
		run: (request, options) => runDirect(request, options?.signal),
	};
}
