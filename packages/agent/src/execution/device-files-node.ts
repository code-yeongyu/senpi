import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DeviceFileError, type DeviceFiles, type DeviceFileStat, FILE_CHANNEL_MAX_BYTES } from "./device-files.ts";

function deviceError(error: unknown, path: string): DeviceFileError {
	if (error instanceof DeviceFileError) return error;
	const code = (error as { code?: unknown }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOENT") return new DeviceFileError("not_found", path);
	if (code === "EEXIST") return new DeviceFileError("exists", path);
	if (code === "EISDIR" || code === "ENOTDIR") return new DeviceFileError("not_a_file", path);
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
		read: (path, options) =>
			guarded(path, options?.signal, async () => {
				const entry = await stat(path);
				if (!entry.isFile()) throw new DeviceFileError("not_a_file", path);
				if (entry.size > FILE_CHANNEL_MAX_BYTES) throw new DeviceFileError("too_large", path);
				return new Uint8Array(await readFile(path, options?.signal ? { signal: options.signal } : {}));
			}),
		write: (path, data, options) =>
			guarded(path, options?.signal, async () => {
				if (data.byteLength > FILE_CHANNEL_MAX_BYTES) throw new DeviceFileError("too_large", path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, data, { flag: options?.exclusive ? "wx" : "w" });
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
