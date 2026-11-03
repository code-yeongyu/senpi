import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DeviceFileError, type DeviceFiles, type DeviceFileStat, FILE_CHANNEL_MAX_BYTES } from "./device-files.ts";

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
	};
}
